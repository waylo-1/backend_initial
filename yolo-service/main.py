import torch
import torch.serialization
from ultralytics.nn.tasks import DetectionModel
torch.serialization.add_safe_globals([DetectionModel])
import asyncio
import base64
import io
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from huggingface_hub import hf_hub_download
from PIL import Image
from pydantic import BaseModel
from ultralytics import YOLO

app = FastAPI(title="Sahayak YOLO Detection Service")

# ── Model loading ──────────────────────────────────────────
# Load ONCE at startup. Never reload per request.
executor = ThreadPoolExecutor(max_workers=2)

omni_model: Optional[YOLO] = None
macos_model: Optional[YOLO] = None
# Vision-text model for semantic box↔label matching. YOLO boxes carry no
# text, so without this the caller can't tell "the Bold icon" from any other
# icon. MATCH_MODEL=siglip (default, better text-image matching) | clip |
# off. DISABLE_CLIP_MATCH=1 also disables (legacy name, kept working).
clip_model = None
clip_processor = None
match_model_name = ""


@app.on_event("startup")
def load_models():
    global omni_model, macos_model, clip_model, clip_processor

    print("[YOLO] Loading OmniParser icon_detect...")
    omni_path = "weights/icon_detect/model.pt"
    if not os.path.exists(omni_path):
        raise RuntimeError(
            f"OmniParser weights not found at {omni_path}. "
            "Run: huggingface-cli download microsoft/OmniParser-v2.0 "
            "'icon_detect/model.pt' --local-dir weights"
        )
    omni_model = YOLO(omni_path)
    print("[YOLO] OmniParser loaded.")

    print("[YOLO] Loading Screen2AX yolov11l...")
    # A fine-tuned checkpoint (finetune/train.py) takes precedence; the hub
    # download would otherwise clobber it on restart.
    custom_path = "weights/screen2ax-custom/ui-elements-detection.pt"
    if os.path.exists(custom_path):
        macos_path = custom_path
        print("[YOLO] Using FINE-TUNED Screen2AX checkpoint (weights/screen2ax-custom).")
    else:
        macos_path = hf_hub_download(
            repo_id="macpaw-research/yolov11l-ui-elements-detection",
            filename="ui-elements-detection.pt",
            local_dir="weights/screen2ax",
        )
    macos_model = YOLO(macos_path)
    print("[YOLO] Screen2AX loaded.")

    global match_model_name
    requested = os.environ.get("MATCH_MODEL", "siglip").lower()
    if os.environ.get("DISABLE_CLIP_MATCH") == "1" or requested == "off":
        print("[MATCH] disabled by env.")
    else:
        # Try SigLIP first (stronger text-image matching at similar cost),
        # fall back to CLIP, fall back to none — detection always works.
        candidates = (["siglip", "clip"] if requested == "siglip" else ["clip"])
        from transformers import AutoModel, AutoProcessor
        repos = {
            "siglip": "google/siglip-base-patch16-224",
            "clip": "openai/clip-vit-base-patch32",
        }
        for name in candidates:
            try:
                repo = repos[name]
                print(f"[MATCH] Loading {repo}...")
                # AutoModel/AutoProcessor avoids class-name import errors across
                # transformers versions; use_fast=True skips the SentencePiece
                # slow tokenizer path when a fast one exists.
                clip_model = AutoModel.from_pretrained(repo)
                clip_processor = AutoProcessor.from_pretrained(repo, use_fast=True)
                clip_model.eval()
                match_model_name = name
                print(f"[MATCH] {name} loaded — semantic box matching enabled.")
                break
            except Exception as e:  # degrade gracefully
                import traceback
                print(f"[MATCH] {name} load failed: {e}")
                traceback.print_exc()
                clip_model = None
                clip_processor = None
    load_custom_vocab()
    build_icon_vocab()
    print("[YOLO] Service ready.")


# ── Request/Response models ────────────────────────────────
class DetectRequest(BaseModel):
    screenshot_b64: str
    target_label: Optional[str] = None
    step_instruction: Optional[str] = None
    screen_region: Optional[str] = None  # menuBar|ribbon|dialog|sidebar|fullScreen


class DetectedElement(BaseModel):
    x: float        # normalized 0-1, left edge, top-left origin
    y: float        # normalized 0-1, top edge, top-left origin
    w: float        # normalized width
    h: float        # normalized height
    cx: float       # center x, normalized 0-1
    cy: float       # center y, normalized 0-1
    confidence: float
    source: str     # "screen2ax" | "omniparser"
    ax_class: Optional[str]  # "AXButton" etc. from Screen2AX, None from OmniParser
    # RELATIVE score: similarity softmaxed across all scored boxes (sums to ~1).
    # Tells you which box is most target-like — but a softmax ALWAYS crowns a
    # winner, even when the target is absent from the image entirely.
    match_score: Optional[float] = None
    # ABSOLUTE score: raw cosine similarity of this crop vs the target text
    # (SigLIP: its calibrated sigmoid probability). This is what says "the
    # target is actually HERE", independent of the other boxes. Callers must
    # gate on this, or a screen without the target still yields a confident
    # (and wrong) winner.
    match_conf: Optional[float] = None
    # Tier 2: zero-shot concept label ("search", "attach") for a textless icon,
    # or None when no vocabulary concept matched distinctly.
    caption: Optional[str] = None


class DetectResponse(BaseModel):
    elements: list[DetectedElement]
    omni_count: int
    macos_count: int
    merged_count: int
    # True when match_score was computed for this request.
    match_applied: bool = False


# ── IoU helper ─────────────────────────────────────────────
def iou(a: dict, b: dict) -> float:
    ax1, ay1 = a["x"], a["y"]
    ax2, ay2 = a["x"] + a["w"], a["y"] + a["h"]
    bx1, by1 = b["x"], b["y"]
    bx2, by2 = b["x"] + b["w"], b["y"] + b["h"]
    inter_w = max(0, min(ax2, bx2) - max(ax1, bx1))
    inter_h = max(0, min(ay2, by2) - max(ay1, by1))
    inter = inter_w * inter_h
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


# ── Merge logic ────────────────────────────────────────────
def merge_results(omni_res, macos_res, img_size: tuple) -> list[dict]:
    W, H = img_size
    boxes = []

    # Screen2AX FIRST — higher priority, has AX class names
    for box in macos_res.boxes:
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        cls_name = macos_res.names[int(box.cls[0])]
        cx = ((x1 + x2) / 2) / W
        cy = ((y1 + y2) / 2) / H
        boxes.append({
            "x": x1 / W, "y": y1 / H,
            "w": (x2 - x1) / W, "h": (y2 - y1) / H,
            "cx": cx, "cy": cy,
            "confidence": float(box.conf[0]),
            "source": "screen2ax",
            "ax_class": cls_name,
        })

    # OmniParser SECOND — add only if NOT overlapping any Screen2AX box by > 40%
    for box in omni_res.boxes:
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        cx = ((x1 + x2) / 2) / W
        cy = ((y1 + y2) / 2) / H
        candidate = {
            "x": x1 / W, "y": y1 / H,
            "w": (x2 - x1) / W, "h": (y2 - y1) / H,
            "cx": cx, "cy": cy,
            "confidence": float(box.conf[0]),
            "source": "omniparser",
            "ax_class": None,
        }
        if not any(iou(candidate, existing) > 0.4 for existing in boxes):
            boxes.append(candidate)

    return sorted(boxes, key=lambda b: b["confidence"], reverse=True)


# ── CLIP semantic matching ─────────────────────────────────
# How many top-confidence boxes get scored (bounds CPU latency: one batched
# forward pass over N crops, ~200-400ms on CPU for 16).
CLIP_MAX_BOXES = 16
# Pad crops slightly — icons are tiny and CLIP benefits from a little context.
CLIP_CROP_PAD = 0.15


def _as_embedding(out):
    """transformers 4.x returns a Tensor from get_*_features; 5.x returns a
    BaseModelOutputWithPooling. Accept either."""
    import torch
    if isinstance(out, torch.Tensor):
        return out
    for attr in ("pooler_output", "text_embeds", "image_embeds", "last_hidden_state"):
        value = getattr(out, attr, None)
        if isinstance(value, torch.Tensor):
            return value if value.dim() == 2 else value.mean(dim=1)
    raise TypeError(f"cannot extract embedding tensor from {type(out).__name__}")


def _crop_boxes(img: Image.Image, boxes: list[dict]) -> list[Image.Image]:
    """Padded crops for a set of normalized boxes (icons benefit from context)."""
    W, H = img.size
    crops = []
    for b in boxes:
        pad_w, pad_h = b["w"] * CLIP_CROP_PAD, b["h"] * CLIP_CROP_PAD
        left = max(0, (b["x"] - pad_w) * W)
        top = max(0, (b["y"] - pad_h) * H)
        right = min(W, (b["x"] + b["w"] + pad_w) * W)
        bottom = min(H, (b["y"] + b["h"] + pad_h) * H)
        if right - left < 4 or bottom - top < 4:
            crops.append(img.resize((32, 32)))  # degenerate box — placeholder crop
        else:
            crops.append(img.crop((left, top, right, bottom)))
    return crops


def clip_match(img: Image.Image, boxes: list[dict], target_label: str,
               step_instruction: str) -> None:
    """Scores each box's crop against the target text and writes match_score
    in place. Softmax across boxes → a RELATIVE 'which box means the target'
    distribution, which is exactly what the caller needs to pick one."""
    import torch

    scored = sorted(boxes, key=lambda b: b["confidence"], reverse=True)[:CLIP_MAX_BOXES]
    if not scored:
        return

    crops = _crop_boxes(img, scored)

    # Two phrasings of the target; their embeddings are averaged. The plain
    # label helps for text buttons, the template helps for icons.
    texts = [target_label, f"the {target_label} button or icon in a user interface"]
    if step_instruction:
        texts.append(step_instruction)

    # Use the tokenizer / image processor DIRECTLY rather than the combined
    # Processor.__call__, whose signature and returned keys shifted between
    # transformers 4.x and 5.x. Pass each model only the tensors it needs.
    tokenizer = getattr(clip_processor, "tokenizer", clip_processor)
    image_processor = getattr(clip_processor, "image_processor", clip_processor)
    as_embedding = _as_embedding

    with torch.no_grad():
        if match_model_name == "siglip":
            # SigLIP is trained with fixed 64-token, max_length-padded input.
            text_in = tokenizer(texts, padding="max_length", max_length=64,
                                truncation=True, return_tensors="pt")
            text_in.pop("attention_mask", None)   # SigLIP text tower ignores it
        else:
            text_in = tokenizer(texts, padding=True, truncation=True, return_tensors="pt")

        text_emb = as_embedding(clip_model.get_text_features(**text_in))
        text_emb = text_emb / text_emb.norm(dim=-1, keepdim=True)
        text_emb = text_emb.mean(dim=0, keepdim=True)
        text_emb = text_emb / text_emb.norm(dim=-1, keepdim=True)

        img_in = image_processor(images=crops, return_tensors="pt")
        img_emb = as_embedding(clip_model.get_image_features(pixel_values=img_in["pixel_values"]))
        img_emb = img_emb / img_emb.norm(dim=-1, keepdim=True)

        sims = (img_emb @ text_emb.T).squeeze(1)          # cosine similarities
        probs = torch.softmax(sims * 100.0, dim=0)        # relative: who wins
        confs = sims                                       # absolute: is it here at all?

        # SigLIP is trained with a sigmoid loss, so sigmoid(logit_scale * sim +
        # logit_bias) is a CALIBRATED "does this image match this text"
        # probability — exactly the absent-target check a softmax can't give.
        if match_model_name == "siglip":
            scale = getattr(clip_model, "logit_scale", None)
            bias = getattr(clip_model, "logit_bias", None)
            if scale is not None and bias is not None:
                confs = torch.sigmoid(sims * scale.exp() + bias).squeeze(-1)

    for b, p, c in zip(scored, probs.tolist(), confs.tolist()):
        b["match_score"] = round(float(p), 4)
        b["match_conf"] = round(float(c), 4)


# ── Zero-shot icon captioning (Tier 2) ─────────────────────
# Turn each textless icon into TEXT by picking its closest concept from a fixed
# vocabulary (OmniParser's caption-first idea, done cheaply by reusing SigLIP as
# a zero-shot classifier — no extra model, no GPU). The caption rides along on
# each box so the Set-of-Mark decider sees "#7 search, #8 attach" instead of
# guessing from pixels alone.
ICON_VOCAB = [
    ("search", "a search or magnifying-glass icon"),
    ("settings", "a settings gear icon"),
    ("add", "an add or plus icon"),
    ("close", "a close or X icon"),
    ("menu", "a hamburger menu icon with stacked lines"),
    ("more options", "a three-dots more-options icon"),
    ("back", "a back or left-arrow icon"),
    ("forward", "a forward or right-arrow icon"),
    ("home", "a home icon"),
    ("attach", "a paperclip attachment icon"),
    ("send", "a send or paper-plane icon"),
    ("microphone", "a microphone voice icon"),
    ("camera", "a camera or take-photo icon"),
    ("image", "a photo or image icon"),
    ("emoji", "a smiley-face emoji icon"),
    ("play", "a play triangle icon"),
    ("pause", "a pause icon"),
    ("next", "a next-track skip-forward icon"),
    ("previous", "a previous-track skip-back icon"),
    ("download", "a download icon"),
    ("share", "a share icon"),
    ("delete", "a delete or trash-can icon"),
    ("edit", "an edit or pencil icon"),
    ("like", "a heart or like icon"),
    ("bookmark", "a star or bookmark icon"),
    ("notifications", "a bell notifications icon"),
    ("profile", "a person or profile-avatar icon"),
    ("calendar", "a calendar icon"),
    ("location", "a location map-pin icon"),
    ("filter", "a filter icon"),
    ("refresh", "a refresh or reload icon"),
    ("expand", "a chevron-down expand icon"),
    ("checkmark", "a checkmark or tick icon"),
    ("info", "an information icon"),
    ("lock", "a padlock lock icon"),
    ("show", "an eye show/hide icon"),
]
icon_vocab_emb = None  # torch tensor [V, D], L2-normalized
# Learned concepts (idea 5): user-verified icon names harvested from real use,
# appended to the built-in vocabulary and persisted across restarts. The
# vocabulary GROWS with the product instead of staying a static English list.
CUSTOM_VOCAB_PATH = "weights/custom_vocab.json"
custom_vocab: list = []  # [(name, phrase)]


def load_custom_vocab():
    global custom_vocab
    try:
        if os.path.exists(CUSTOM_VOCAB_PATH):
            with open(CUSTOM_VOCAB_PATH) as f:
                custom_vocab = [tuple(x) for x in json.load(f)]
            print(f"[CAPTION] loaded {len(custom_vocab)} learned concepts.")
    except Exception as e:
        print(f"[CAPTION] custom vocab load failed: {e}")
        custom_vocab = []


def full_vocab():
    return ICON_VOCAB + custom_vocab


def build_icon_vocab():
    """Embed the icon vocabulary (built-in + learned). Called at startup and
    again whenever a new concept is learned."""
    global icon_vocab_emb
    if clip_model is None:
        return
    import torch
    tokenizer = getattr(clip_processor, "tokenizer", clip_processor)
    phrases = [p for _, p in full_vocab()]
    try:
        with torch.no_grad():
            if match_model_name == "siglip":
                tin = tokenizer(phrases, padding="max_length", max_length=64,
                                truncation=True, return_tensors="pt")
                tin.pop("attention_mask", None)
            else:
                tin = tokenizer(phrases, padding=True, truncation=True, return_tensors="pt")
            emb = _as_embedding(clip_model.get_text_features(**tin))
            emb = emb / emb.norm(dim=-1, keepdim=True)
        icon_vocab_emb = emb
        print(f"[CAPTION] icon vocabulary embedded ({len(phrases)} concepts, {len(custom_vocab)} learned).")
    except Exception as e:
        print(f"[CAPTION] vocab embed failed: {e}")


# Only assign a caption when the top concept beats the runner-up by this margin —
# an ambiguous crop (no distinct icon) gets no caption rather than a wrong guess.
CAPTION_MARGIN = 0.03


def caption_boxes(img: Image.Image, boxes: list[dict], max_boxes: int = 36) -> None:
    """Writes a best-guess `caption` on each box via zero-shot vocab matching."""
    if clip_model is None or icon_vocab_emb is None:
        return
    import torch
    scored = sorted(boxes, key=lambda b: b["confidence"], reverse=True)[:max_boxes]
    if not scored:
        return
    crops = _crop_boxes(img, scored)
    image_processor = getattr(clip_processor, "image_processor", clip_processor)
    with torch.no_grad():
        img_in = image_processor(images=crops, return_tensors="pt")
        img_emb = _as_embedding(clip_model.get_image_features(pixel_values=img_in["pixel_values"]))
        img_emb = img_emb / img_emb.norm(dim=-1, keepdim=True)
        sims = img_emb @ icon_vocab_emb.T            # [N, V] cosine
        top2 = torch.topk(sims, k=2, dim=1)
    vocab = full_vocab()
    for b, vals, idxs in zip(scored, top2.values.tolist(), top2.indices.tolist()):
        if vals[0] - vals[1] > CAPTION_MARGIN:       # distinct match only
            b["caption"] = vocab[idxs[0]][0]


# ── Main detection endpoint ────────────────────────────────
def run_omni(img: Image.Image):
    return omni_model(img, conf=0.25, verbose=False)[0]


def run_macos(img: Image.Image):
    return macos_model(img, conf=0.25, verbose=False)[0]


@app.post("/detect", response_model=DetectResponse)
async def detect(req: DetectRequest):
    if omni_model is None or macos_model is None:
        raise HTTPException(status_code=503, detail="Models not loaded yet")

    try:
        img_bytes = base64.b64decode(req.screenshot_b64)
        img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image: {e}")

    # Run both models in parallel: total latency = max(omni, macos), not sum.
    loop = asyncio.get_running_loop()
    omni_future = loop.run_in_executor(executor, run_omni, img)
    macos_future = loop.run_in_executor(executor, run_macos, img)
    omni_res, macos_res = await asyncio.gather(omni_future, macos_future)

    omni_count = len(omni_res.boxes)
    macos_count = len(macos_res.boxes)
    print(f"[YOLO] OmniParser: {omni_count} boxes | Screen2AX: {macos_count} boxes")

    merged = merge_results(omni_res, macos_res, img.size)
    print(f"[YOLO] Merged: {len(merged)} boxes after IoU dedup")

    # Semantic matching: score boxes against the step's target text so the
    # caller can pick the box that MEANS the target, not just any confident one.
    match_applied = False
    label = (req.target_label or "").strip()
    if clip_model is not None and label:
        try:
            loop2 = asyncio.get_running_loop()
            await loop2.run_in_executor(
                executor, clip_match, img, merged, label, (req.step_instruction or "").strip()
            )
            match_applied = True
            if merged:
                best = max(merged, key=lambda b: b.get("match_score") or 0)
                print(f"[MATCH] '{label}' — top score {best.get('match_score'):.2f} "
                      f"conf {best.get('match_conf'):.3f} (conf is the absent-target check)")
        except Exception as e:
            import traceback
            print(f"[CLIP] match failed ({type(e).__name__}: {e}) — returning unscored boxes")
            traceback.print_exc()
    elif clip_model is not None and not label:
        # No specific target → the Set-of-Mark path wants ALL boxes captioned
        # so textless icons arrive as words ("search", "attach").
        try:
            loop3 = asyncio.get_running_loop()
            await loop3.run_in_executor(executor, caption_boxes, img, merged)
            captioned = sum(1 for b in merged if b.get("caption"))
            print(f"[CAPTION] labelled {captioned}/{len(merged)} boxes")
        except Exception as e:
            print(f"[CAPTION] failed ({type(e).__name__}: {e}) — boxes uncaptioned")

    elements = [DetectedElement(**b) for b in merged]
    return DetectResponse(
        elements=elements,
        omni_count=omni_count,
        macos_count=macos_count,
        merged_count=len(merged),
        match_applied=match_applied,
    )


class VocabRequest(BaseModel):
    name: str                      # short concept ("shuffle")
    phrase: Optional[str] = None   # optional full phrase for the embedder


@app.post("/vocab")
async def add_vocab(req: VocabRequest):
    """Learn a new icon concept (idea 5): called when a USER-VERIFIED detection
    carries a concept the vocabulary doesn't know. Appends, re-embeds, persists —
    the captioner recognises it from then on."""
    name = re.sub(r"[^a-z0-9 ]", "", req.name.strip().lower())[:40].strip()
    if not name or len(name) < 3:
        raise HTTPException(status_code=400, detail="name too short")
    existing = {n for n, _ in full_vocab()}
    if name in existing:
        return {"added": False, "reason": "known", "total": len(full_vocab())}
    phrase = (req.phrase or f"a {name} icon in a user interface").strip()[:120]
    custom_vocab.append((name, phrase))
    try:
        os.makedirs(os.path.dirname(CUSTOM_VOCAB_PATH), exist_ok=True)
        with open(CUSTOM_VOCAB_PATH, "w") as f:
            json.dump([list(x) for x in custom_vocab], f)
    except Exception as e:
        print(f"[CAPTION] persist failed: {e}")
    # Re-embed in the worker pool (CPU-bound, ~100ms).
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(executor, build_icon_vocab)
    print(f"[CAPTION] learned concept '{name}'")
    return {"added": True, "total": len(full_vocab())}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "omni_loaded": omni_model is not None,
        "macos_loaded": macos_model is not None,
        "clip_loaded": clip_model is not None,
        "match_model": match_model_name,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
