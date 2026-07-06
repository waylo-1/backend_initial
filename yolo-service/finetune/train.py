#!/usr/bin/env python3
"""Fine-tunes one of Waylo's two detectors on the harvested dataset.

  --base omni       start from OmniParser icon_detect (single-class); use with
                    a dataset made by `prepare_dataset.py --mode omni`
  --base screen2ax  start from MacPaw's yolov11l (AX classes); use with
                    `prepare_dataset.py --mode screen2ax`

Conservative defaults for SMALL harvested datasets: frozen backbone, low LR,
strong augmentation off (UI screenshots are rigid — flips/rotations create
impossible layouts). Run on a GPU box; CPU works for tiny sets but is slow.

  python3 train.py --base omni --data dataset_omni/data.yaml --epochs 40
"""

import argparse
import os
from pathlib import Path


def base_weights(which: str) -> str:
    if which == "omni":
        p = Path("../weights/icon_detect/model.pt")
        if not p.exists():
            raise SystemExit(
                "OmniParser weights missing — run ../download_weights.sh first")
        return str(p)
    from huggingface_hub import hf_hub_download
    return hf_hub_download(
        repo_id="macpaw-research/yolov11l-ui-elements-detection",
        filename="ui-elements-detection.pt",
        local_dir="../weights/screen2ax",
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", choices=["omni", "screen2ax"], required=True)
    ap.add_argument("--data", required=True, help="path to data.yaml")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--imgsz", type=int, default=1280)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--freeze", type=int, default=10,
                    help="backbone layers to freeze (guards small datasets)")
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--name", default=None)
    args = ap.parse_args()

    from ultralytics import YOLO

    model = YOLO(base_weights(args.base))
    run_name = args.name or f"waylo_{args.base}_ft"

    model.train(
        data=args.data,
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        freeze=args.freeze,
        lr0=args.lr,
        # UI screenshots: geometric augments create impossible layouts.
        fliplr=0.0, flipud=0.0, degrees=0.0, shear=0.0, perspective=0.0,
        mosaic=0.3, scale=0.2, translate=0.05,
        patience=12,
        name=run_name,
        project="runs",
    )

    best = Path("runs") / run_name / "weights" / "best.pt"
    print("\n=== done ===")
    print(f"best checkpoint: {best}")
    if args.base == "omni":
        print("deploy: cp that file over ../weights/icon_detect/model.pt and "
              "restart the service")
    else:
        print("deploy: put it at ../weights/screen2ax-custom/ui-elements-detection.pt "
              "(the service prefers that path over the hub download) and restart")
    print("ALWAYS eval before deploying:  yolo val model=<best.pt> data=" + args.data)


if __name__ == "__main__":
    main()
