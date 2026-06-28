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


@app.on_event("startup")
def load_models():
    global omni_model, macos_model

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
    macos_path = hf_hub_download(
        repo_id="macpaw-research/yolov11l-ui-elements-detection",
        filename="ui-elements-detection.pt",
        local_dir="weights/screen2ax",
    )
    macos_model = YOLO(macos_path)
    print("[YOLO] Screen2AX loaded.")
    print("[YOLO] Both models ready.")


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


class DetectResponse(BaseModel):
    elements: list[DetectedElement]
    omni_count: int
    macos_count: int
    merged_count: int


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

    elements = [DetectedElement(**b) for b in merged]
    return DetectResponse(
        elements=elements,
        omni_count=omni_count,
        macos_count=macos_count,
        merged_count=len(merged),
    )


@app.get("/health")
def health():
    return {
        "status": "ok",
        "omni_loaded": omni_model is not None,
        "macos_loaded": macos_model is not None,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
