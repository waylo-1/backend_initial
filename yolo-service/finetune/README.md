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

## 4. Evaluate, then deploy

```bash
yolo val model=runs/waylo_omni_ft/weights/best.pt data=dataset_omni/data.yaml
```

Only deploy if val mAP beats the base model on YOUR data:

- OmniParser: `cp runs/waylo_omni_ft/weights/best.pt ../weights/icon_detect/model.pt`
- Screen2AX: `cp runs/waylo_screen2ax_ft/weights/best.pt ../weights/screen2ax-custom/ui-elements-detection.pt`
  (the service prefers `screen2ax-custom/` over the hub download)

Restart the service; `/health` shows which models loaded.
