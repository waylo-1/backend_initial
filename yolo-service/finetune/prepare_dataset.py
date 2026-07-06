#!/usr/bin/env python3
"""Converts Waylo's harvested training log into a YOLO fine-tuning dataset.

Input: the macOS app's on-device harvest —
  ~/Library/Application Support/Sahayak/yolo_training_log.jsonl
  ~/Library/Application Support/Sahayak/training_images/*.jpg

Only entries that carry an `image_file` are usable (the app saves images only
when the user enabled "Save YOLO training screenshots" in dev tools). Each
entry's `bbox_0_1000` (Nova-verified) becomes the ground-truth box.

Two modes:
  --mode omni       single class 0 ("interactable") — fine-tunes OmniParser's
                    icon_detect head. Every harvested example is usable.
  --mode screen2ax  multi-class — maps the step's control_kind onto the
                    Screen2AX model's class names; entries whose control_kind
                    has no mapping are skipped.

Usage:
  python3 prepare_dataset.py --source "~/Library/Application Support/Sahayak" \
      --out dataset_omni --mode omni --val-split 0.1
"""

import argparse
import json
import random
import shutil
from pathlib import Path

# control_kind (Waylo step field) → Screen2AX class name. Extend as needed;
# check the actual names with:  YOLO(<screen2ax.pt>).names
CONTROL_KIND_TO_AX = {
    "button": "AXButton",
    "menuitem": "AXMenuItem",
    "checkbox": "AXCheckBox",
    "tab": "AXTab",
    "link": "AXLink",
    "field": "AXTextField",
}


def load_entries(source: Path):
    log = source / "yolo_training_log.jsonl"
    if not log.exists():
        raise SystemExit(f"no log at {log}")
    entries = []
    for line in log.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        img = e.get("image_file")
        bbox = e.get("bbox_0_1000")
        if not img or not bbox or len(bbox) != 4:
            continue
        if not (source / img).exists():
            continue
        entries.append(e)
    return entries


def class_index(entry, mode: str, class_names: dict[str, int]):
    if mode == "omni":
        return 0
    ax = CONTROL_KIND_TO_AX.get((entry.get("control_kind") or "").lower())
    if ax is None:
        return None
    return class_names.get(ax)


def screen2ax_class_names() -> dict[str, int]:
    """Reads the class list straight from the Screen2AX checkpoint."""
    from huggingface_hub import hf_hub_download
    from ultralytics import YOLO
    path = hf_hub_download(
        repo_id="macpaw-research/yolov11l-ui-elements-detection",
        filename="ui-elements-detection.pt",
        local_dir="../weights/screen2ax",
    )
    names = YOLO(path).names  # {index: name}
    return {name: idx for idx, name in names.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="~/Library/Application Support/Sahayak")
    ap.add_argument("--out", default="dataset_omni")
    ap.add_argument("--mode", choices=["omni", "screen2ax"], default="omni")
    ap.add_argument("--val-split", type=float, default=0.1)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    source = Path(args.source).expanduser()
    out = Path(args.out)
    entries = load_entries(source)
    print(f"{len(entries)} trainable entries (with images) in the harvest")
    if len(entries) < 50:
        print("WARNING: <50 examples — fine-tuning this small usually hurts. "
              "Keep collecting (enable the dev-tools capture toggle) or mix in "
              "the MacPaw Screen2AX-Element dataset.")

    names = {}
    if args.mode == "screen2ax":
        names = screen2ax_class_names()
        print(f"Screen2AX classes: {sorted(names, key=names.get)}")

    random.Random(args.seed).shuffle(entries)
    n_val = max(1, int(len(entries) * args.val_split)) if entries else 0

    for split in ("train", "val"):
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)

    kept, skipped = 0, 0
    for i, e in enumerate(entries):
        cls = class_index(e, args.mode, names)
        if cls is None:
            skipped += 1
            continue
        split = "val" if i < n_val else "train"
        src_img = source / e["image_file"]
        stem = f"{Path(e['image_file']).stem}"
        shutil.copy(src_img, out / "images" / split / f"{stem}.jpg")

        # bbox_0_1000 [xMin,yMin,xMax,yMax] → YOLO normalized cx cy w h.
        x1, y1, x2, y2 = [v / 1000.0 for v in e["bbox_0_1000"]]
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        w, h = x2 - x1, y2 - y1
        (out / "labels" / split / f"{stem}.txt").write_text(
            f"{cls} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}\n"
        )
        kept += 1

    if args.mode == "omni":
        yaml_names = "names:\n  0: interactable\n"
    else:
        ordered = sorted(names.items(), key=lambda kv: kv[1])
        yaml_names = "names:\n" + "".join(f"  {i}: {n}\n" for n, i in ordered)

    (out / "data.yaml").write_text(
        f"path: {out.resolve()}\ntrain: images/train\nval: images/val\n{yaml_names}"
    )
    print(f"dataset written to {out}/ — {kept} labelled, {skipped} skipped "
          f"(no class mapping); data.yaml ready for train.py")


if __name__ == "__main__":
    main()
