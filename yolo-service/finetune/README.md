# Fine-tuning Waylo's YOLO detectors on harvested data

Every time Nova (L3) locates an element, the macOS app logs a verified
example. With the **opt-in** capture toggle enabled, the downscaled
screenshot is saved too — those examples are trainable.

## 1. Collect

In the Waylo panel → hammer icon (dev tools) → enable
**"Save YOLO training screenshots"**. Data accumulates at:

```
~/Library/Application Support/Sahayak/yolo_training_log.jsonl
~/Library/Application Support/Sahayak/training_images/*.jpg
```

Aim for **500+ image-bearing entries** before fine-tuning; below ~50 it will
hurt more than help. Only entries logged while the toggle was ON have images.

## 2. Prepare

```bash
cd backend_initial/yolo-service/finetune
pip install -r ../requirements.txt

# single-class dataset for OmniParser's icon_detect head (uses every example):
python3 prepare_dataset.py --mode omni --out dataset_omni

# multi-class dataset for the Screen2AX model (uses entries whose step had a
# control_kind that maps to an AX class):
python3 prepare_dataset.py --mode screen2ax --out dataset_ax
```

## 3. Train (GPU box recommended)

```bash
python3 train.py --base omni      --data dataset_omni/data.yaml --epochs 40
python3 train.py --base screen2ax --data dataset_ax/data.yaml   --epochs 40
```

Defaults are tuned for small datasets: frozen backbone (10 layers), low LR,
no flips/rotations (UI layouts are rigid — mirrored screenshots teach lies).

To guard against catastrophic forgetting on the Screen2AX model, mix in a
slice of MacPaw's public training data (`Screen2AX-Element` on Hugging Face,
under `macpaw-research`) by converting it into the same dataset folder before
training — optional, but recommended once your harvest is large.

### 2b. Mixing in external datasets — `convert_external.py`

`prepare_dataset.py` only reads YOUR harvested JSONL. To fold in a public
labelled-picture dataset (images + boxes) — the thing you actually train YOLO
on — use `convert_external.py`. It emits the **same** `images/ labels/
data.yaml` layout, so point `--out` at a dataset you already built to MERGE, or
at a new folder. **It prints the schema it detects (features, class names, a
sample box) — read that first**, then set `--bbox-format` / `--class-map` if the
sample box or labels look wrong. Names ≠ pictures: this trains *detection*
(where the boxes are); *which icon* still comes from SigLIP + the vocab.

Install extras: `pip install datasets pillow`.

**MacPaw `Screen2AX-Element`** (HF; labels are already AX-style element
classes → best fit for the Screen2AX head, closest to macOS):

```bash
# build your harvest set first (so classes are numbered by the checkpoint)…
python3 prepare_dataset.py --mode screen2ax --out dataset_ax
# …then merge MacPaw in on top:
python3 convert_external.py --source hf:macpaw-research/Screen2AX-Element \
    --mode screen2ax --out dataset_ax --split train --prefix macpaw
# HF detection boxes are COCO xywh-abs by default; if the printed sample box
# looks like corners not width/height, add: --bbox-format xyxy_abs
```

**WebUI** (best public set for your web-app weak spot — Gmail/Docs are web
UIs). Download a WebUI split locally (each page = a screenshot + a JSON of
element boxes/roles), then adapt the keys to that dump's schema:

```bash
# class-agnostic boxes for the OmniParser head (simplest, uses everything):
python3 convert_external.py --source dir:/data/webui \
    --mode omni --out dataset_omni --prefix webui \
    --image-glob '**/*.png' \
    --box-key elements --bbox-key box --label-key tag --bbox-format xyxy_abs

# or map HTML roles → AX classes for the Screen2AX head:
python3 convert_external.py --source dir:/data/webui \
    --mode screen2ax --out dataset_ax --prefix webui \
    --image-glob '**/*.png' --box-key elements --bbox-key box \
    --label-key role --bbox-format xyxy_abs --class-map webui_roles.json
```

`--box-key` is the dotted path to the box LIST inside each page JSON,
`--bbox-key` the path to a single box's 4 numbers, `--label-key` the element's
role/tag. `--class-map` is `{ "button": "AXButton", "a": "AXLink", … }`
(built-in defaults already cover the common web roles; AX-prefixed labels pass
through). Use `--limit 200` for a quick dry run to confirm the mapping before
converting the whole set.

## 4. Evaluate, then deploy

```bash
yolo val model=runs/waylo_omni_ft/weights/best.pt data=dataset_omni/data.yaml
```

Only deploy if val mAP beats the base model on YOUR data:

- OmniParser: `cp runs/waylo_omni_ft/weights/best.pt ../weights/icon_detect/model.pt`
- Screen2AX: `cp runs/waylo_screen2ax_ft/weights/best.pt ../weights/screen2ax-custom/ui-elements-detection.pt`
  (the service prefers `screen2ax-custom/` over the hub download)

Restart the service; `/health` shows which models loaded.
