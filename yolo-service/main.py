import asyncio
import base64
import io
import os
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
        for name in candidates:
            try:
                if name == "siglip":
                    from transformers import SiglipModel, SiglipProcessor
                    print("[MATCH] Loading google/siglip-base-patch16-224...")
                    clip_model = SiglipModel.from_pretrained("google/siglip-base-patch16-224")
                    clip_processor = SiglipProcessor.from_pretrained("google/siglip-base-patch16-224")
                else:
                    from transformers import CLIPModel, CLIPProcessor
                    print("[MATCH] Loading openai/clip-vit-base-patch32...")
                    clip_model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32")
                    clip_processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
                clip_model.eval()
                match_model_name = name
                print(f"[MATCH] {name} loaded — semantic box matching enabled.")
                break
            except Exception as e:  # degrade gracefully
                print(f"[MATCH] {name} load failed ({e})")
                clip_model = None
                clip_processor = None
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
    # CLIP similarity of this box's crop vs the step's target text, softmaxed
    # across all scored boxes (0-1, sums to ~1). None when CLIP is disabled or
    # no target_label was sent. The box that best MEANS the target wins.
    match_score: Optional[float] = None


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


def clip_match(img: Image.Image, boxes: list[dict], target_label: str,
               step_instruction: str) -> None:
    """Scores each box's crop against the target text and writes match_score
    in place. Softmax across boxes → a RELATIVE 'which box means the target'
    distribution, which is exactly what the caller needs to pick one."""
    import torch

    scored = sorted(boxes, key=lambda b: b["confidence"], reverse=True)[:CLIP_MAX_BOXES]
    if not scored:
        return

    W, H = img.size
    crops = []
    for b in scored:
        pad_w, pad_h = b["w"] * CLIP_CROP_PAD, b["h"] * CLIP_CROP_PAD
        left = max(0, (b["x"] - pad_w) * W)
        top = max(0, (b["y"] - pad_h) * H)
        right = min(W, (b["x"] + b["w"] + pad_w) * W)
        bottom = min(H, (b["y"] + b["h"] + pad_h) * H)
        if right - left < 4 or bottom - top < 4:
            crops.append(img.resize((32, 32)))  # degenerate box — placeholder crop
        else:
            crops.append(img.crop((left, top, right, bottom)))

    # Two phrasings of the target; their embeddings are averaged. The plain
    # label helps for text buttons, the template helps for icons.
    texts = [target_label, f"the {target_label} button or icon in a user interface"]
    if step_instruction:
        texts.append(step_instruction)

    with torch.no_grad():
        # SigLIP's tokenizer requires max_length padding for correct output.
        pad = "max_length" if match_model_name == "siglip" else True
        text_in = clip_processor(text=texts, return_tensors="pt", padding=pad, truncation=True)
        text_emb = clip_model.get_text_features(**text_in)
        text_emb = text_emb / text_emb.norm(dim=-1, keepdim=True)
        text_emb = text_emb.mean(dim=0, keepdim=True)
        text_emb = text_emb / text_emb.norm(dim=-1, keepdim=True)

        img_in = clip_processor(images=crops, return_tensors="pt")
        img_emb = clip_model.get_image_features(**img_in)
        img_emb = img_emb / img_emb.norm(dim=-1, keepdim=True)

        sims = (img_emb @ text_emb.T).squeeze(1)          # cosine similarities
        probs = torch.softmax(sims * 100.0, dim=0)        # CLIP-style temperature

    for b, p in zip(scored, probs.tolist()):
        b["match_score"] = round(p, 4)


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
            top = max((b.get("match_score") or 0) for b in merged) if merged else 0
            print(f"[CLIP] matched '{label}' — top score {top:.2f}")
        except Exception as e:
            print(f"[CLIP] match failed ({e}) — returning unscored boxes")

    elements = [DetectedElement(**b) for b in merged]
    return DetectResponse(
        elements=elements,
        omni_count=omni_count,
        macos_count=macos_count,
        merged_count=len(merged),
        match_applied=match_applied,
    )


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
