#!/usr/bin/env python3
"""Convert an EXTERNAL UI-element dataset into Waylo's YOLO fine-tune layout.

Produces the SAME folder shape as prepare_dataset.py, so the output can be a
fresh dataset OR merged into an existing one (run prepare_dataset.py on your
harvest first, then point this at the same --out to add external data):

    <out>/images/{train,val}/*.jpg
    <out>/labels/{train,val}/*.txt      # "<cls> cx cy w h" normalized
    <out>/data.yaml

Two class schemes, matching prepare_dataset.py:
  --mode omni       every element box → class 0 "interactable"
                    (fine-tunes OmniParser's icon_detect head)
  --mode screen2ax  map each source label → a Screen2AX AX class; the class
                    indices are read from the SAME checkpoint prepare_dataset.py
                    uses, so a merged dataset stays consistent. Unmapped labels
                    are skipped.

Two sources:
  --source hf:<repo_id>          a HuggingFace object-detection dataset, e.g.
                                 hf:macpaw-research/Screen2AX-Element
                                 (needs: pip install datasets pillow)
  --source dir:<path>            a directory of screenshots each with a sidecar
                                 JSON of boxes (WebUI-style local dumps).

IMPORTANT — run it once and READ THE PRINTED SCHEMA before trusting the output.
Dataset schemas vary; this tool prints the detected features / class names / a
sample box so you can set --bbox-format, --box-key, --label-key and --class-map
correctly. Wrong flags = silently wrong labels.

Recipes
-------
MacPaw Screen2AX-Element (labels are already AX-ish element classes):
    pip install datasets pillow ultralytics huggingface_hub
    python3 convert_external.py --source hf:macpaw-research/Screen2AX-Element \
        --mode screen2ax --out dataset_ax --split train
  (COCO xywh-abs is the HF default; if the printed sample box looks off, pass
   --bbox-format xyxy_abs.)

WebUI (local dump: <page>/screenshot.png + <page>/box.json with pixel boxes):
    python3 convert_external.py --source dir:/data/webui \
        --mode omni --out dataset_omni \
        --image-glob '**/*.png' --box-key elements --bbox-key box \
        --label-key tag --bbox-format xyxy_abs
  For --mode screen2ax add --class-map webui_roles.json mapping HTML roles/tags
  (button, a, input, img, textarea…) to AX classes.
"""
import argparse
import json
import random
from pathlib import Path

# Reuse prepare_dataset.py so the Screen2AX class indices are IDENTICAL — a
# merged dataset must share one class numbering or training reads garbage.
from prepare_dataset import screen2ax_class_names  # noqa: E402

# Default source-label → Screen2AX AX class. Covers HTML/web roles (WebUI) and
# passes AX-prefixed names straight through (MacPaw). Override/extend with
# --class-map <json>. Anything unmapped is skipped in screen2ax mode.
DEFAULT_LABEL_TO_AX = {
    "button": "AXButton", "btn": "AXButton", "submit": "AXButton",
    "a": "AXLink", "link": "AXLink", "anchor": "AXLink",
    "input": "AXTextField", "textbox": "AXTextField", "textfield": "AXTextField",
    "textarea": "AXTextArea", "search": "AXTextField", "searchbox": "AXTextField",
    "checkbox": "AXCheckBox", "radio": "AXRadioButton",
    "tab": "AXTab", "img": "AXImage", "image": "AXImage", "icon": "AXImage",
    "menuitem": "AXMenuItem", "select": "AXPopUpButton", "combobox": "AXComboBox",
}


def to_yolo(bbox, fmt, img_w, img_h):
    """Any supported box format → normalized (cx, cy, w, h), clamped, or None."""
    x = [float(v) for v in bbox[:4]]
    if fmt == "xywh_abs":      # COCO: x_min, y_min, w, h (pixels)
        x1, y1, w, h = x
        x2, y2 = x1 + w, y1 + h
    elif fmt == "xyxy_abs":    # x_min, y_min, x_max, y_max (pixels)
        x1, y1, x2, y2 = x
    elif fmt == "xywh_norm":   # x_min, y_min, w, h (0..1)
        x1, y1 = x[0] * img_w, x[1] * img_h
        x2, y2 = x1 + x[2] * img_w, y1 + x[3] * img_h
    elif fmt == "xyxy_norm":   # x_min, y_min, x_max, y_max (0..1)
        x1, y1, x2, y2 = x[0] * img_w, x[1] * img_h, x[2] * img_w, x[3] * img_h
    else:
        raise SystemExit(f"unknown --bbox-format {fmt}")
    if x2 <= x1 or y2 <= y1:
        return None
    cx = ((x1 + x2) / 2) / img_w
    cy = ((y1 + y2) / 2) / img_h
    w = (x2 - x1) / img_w
    h = (y2 - y1) / img_h
    if not (0 < w <= 1 and 0 < h <= 1):
        return None
    return (min(max(cx, 0), 1), min(max(cy, 0), 1), min(w, 1), min(h, 1))


def resolve(obj, dotted):
    """Fetch obj['a']['b'] for dotted='a.b'; None if absent."""
    cur = obj
    for k in dotted.split("."):
        if isinstance(cur, dict) and k in cur:
            cur = cur[k]
        else:
            return None
    return cur


def label_to_class(raw_label, mode, ax_names, label_map):
    if mode == "omni":
        return 0
    name = str(raw_label).strip()
    ax = name if name.startswith("AX") else label_map.get(name.lower())
    if ax is None:
        return None
    return ax_names.get(ax)


# ── Source: HuggingFace object-detection dataset ───────────────────────────
def iter_hf(repo_id, split, limit):
    from datasets import load_dataset
    ds = load_dataset(repo_id, split=split)
    print(f"[HF] {repo_id} split={split}: {len(ds)} rows")
    print(f"[HF] features: {ds.features}")
    # Class-id → name, when the label feature is a ClassLabel.
    names_by_col = {}
    for col in ("objects", "annotations"):
        feat = ds.features.get(col)
        if feat is not None:
            inner = getattr(feat, "feature", None)
            for lk in ("category", "label", "category_id"):
                sub = getattr(inner, "get", lambda *_: None)(lk) if inner else None
                if sub is not None and hasattr(sub, "names"):
                    names_by_col[lk] = sub.names
    printed = False
    for i, row in enumerate(ds):
        if limit and i >= limit:
            break
        img = row["image"]
        w, h = img.size
        objs = row.get("objects") or row.get("annotations") or {}
        bboxes = resolve(objs, "bbox") or objs.get("boxes") or []
        labels = (objs.get("category") if isinstance(objs, dict) else None)
        if labels is None:
            labels = objs.get("label") if isinstance(objs, dict) else None
        if labels is None:
            labels = objs.get("category_id") if isinstance(objs, dict) else None
        labels = labels or [0] * len(bboxes)
        out_labels = []
        for lb in labels:
            # int id → class name via the ClassLabel table, when we have one.
            if isinstance(lb, int) and names_by_col:
                table = next(iter(names_by_col.values()))
                out_labels.append(table[lb] if lb < len(table) else str(lb))
            else:
                out_labels.append(lb)
        if not printed and bboxes:
            print(f"[HF] sample box={bboxes[0]} label={out_labels[0]} img={w}x{h}")
            printed = True
        yield img, w, h, list(zip(bboxes, out_labels))


# ── Source: local directory of images + sidecar JSON ───────────────────────
def iter_dir(root, image_glob, box_key, bbox_key, label_key, limit):
    from PIL import Image
    root = Path(root).expanduser()
    imgs = sorted(root.glob(image_glob))
    print(f"[DIR] {root} glob={image_glob}: {len(imgs)} images")
    printed = False
    seen = 0
    for img_path in imgs:
        if limit and seen >= limit:
            break
        # sidecar JSON: same stem, else a single .json in the same folder.
        js = img_path.with_suffix(".json")
        if not js.exists():
            cand = list(img_path.parent.glob("*.json"))
            if len(cand) != 1:
                continue
            js = cand[0]
        try:
            data = json.loads(js.read_text())
        except Exception:
            continue
        elements = resolve(data, box_key) if box_key else data
        if not isinstance(elements, list):
            continue
        with Image.open(img_path) as im:
            w, h = im.size
        pairs = []
        for el in elements:
            bb = resolve(el, bbox_key) if bbox_key else el
            if not isinstance(bb, (list, tuple)) or len(bb) < 4:
                continue
            lb = resolve(el, label_key) if label_key else 0
            pairs.append((bb, lb))
        if not printed and pairs:
            print(f"[DIR] sample box={pairs[0][0]} label={pairs[0][1]} img={w}x{h}")
            printed = True
        seen += 1
        yield img_path, w, h, pairs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True,
                    help="hf:<repo_id> or dir:<path>")
    ap.add_argument("--out", default="dataset_omni")
    ap.add_argument("--mode", choices=["omni", "screen2ax"], default="omni")
    ap.add_argument("--split", default="train", help="HF split")
    ap.add_argument("--val-split", type=float, default=0.1)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--bbox-format", default="xywh_abs",
                    choices=["xywh_abs", "xyxy_abs", "xywh_norm", "xyxy_norm"])
    ap.add_argument("--class-map", help="JSON: {source_label: AXClass}")
    ap.add_argument("--limit", type=int, default=0, help="cap N images (trial)")
    ap.add_argument("--prefix", default="", help="filename prefix (avoid clashes)")
    # dir-source knobs
    ap.add_argument("--image-glob", default="**/*.png")
    ap.add_argument("--box-key", default="", help="dotted key to the box LIST")
    ap.add_argument("--bbox-key", default="", help="dotted key to a box's coords")
    ap.add_argument("--label-key", default="", help="dotted key to a box's label")
    args = ap.parse_args()

    from PIL import Image  # noqa: F401  (fail early if Pillow missing)

    label_map = dict(DEFAULT_LABEL_TO_AX)
    if args.class_map:
        label_map.update({k.lower(): v for k, v in
                          json.loads(Path(args.class_map).read_text()).items()})

    ax_names = {}
    if args.mode == "screen2ax":
        ax_names = screen2ax_class_names()
        print(f"Screen2AX classes: {sorted(ax_names, key=ax_names.get)}")

    prefix = args.prefix or ("hf" if args.source.startswith("hf:") else "ext")
    out = Path(args.out)
    for split in ("train", "val"):
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)

    if args.source.startswith("hf:"):
        rows = iter_hf(args.source[3:], args.split, args.limit)
    elif args.source.startswith("dir:"):
        rows = iter_dir(args.source[4:], args.image_glob, args.box_key,
                        args.bbox_key, args.label_key, args.limit)
    else:
        raise SystemExit("--source must start with hf: or dir:")

    rng = random.Random(args.seed)
    n_img, n_box, skipped = 0, 0, 0
    for img, w, h, pairs in rows:
        lines = []
        for bbox, raw_label in pairs:
            cls = label_to_class(raw_label, args.mode, ax_names, label_map)
            if cls is None:
                skipped += 1
                continue
            yolo = to_yolo(bbox, args.bbox_format, w, h)
            if yolo is None:
                skipped += 1
                continue
            lines.append(f"{cls} {yolo[0]:.6f} {yolo[1]:.6f} {yolo[2]:.6f} {yolo[3]:.6f}")
        if not lines:
            continue
        split = "val" if rng.random() < args.val_split else "train"
        stem = f"{prefix}_{n_img:06d}"
        # HF gives a PIL image; dir gives a path.
        if hasattr(img, "save"):
            img.convert("RGB").save(out / "images" / split / f"{stem}.jpg", quality=90)
        else:
            from PIL import Image as _Img
            with _Img.open(img) as im:
                im.convert("RGB").save(out / "images" / split / f"{stem}.jpg", quality=90)
        (out / "labels" / split / f"{stem}.txt").write_text("\n".join(lines) + "\n")
        n_img += 1
        n_box += len(lines)

    # Write data.yaml only if absent (don't clobber a merge target's classes).
    yaml_path = out / "data.yaml"
    if not yaml_path.exists():
        if args.mode == "omni":
            yaml_names = "names:\n  0: interactable\n"
        else:
            ordered = sorted(ax_names.items(), key=lambda kv: kv[1])
            yaml_names = "names:\n" + "".join(f"  {i}: {n}\n" for n, i in ordered)
        yaml_path.write_text(
            f"path: {out.resolve()}\ntrain: images/train\nval: images/val\n{yaml_names}"
        )
        print(f"wrote {yaml_path}")
    else:
        print(f"kept existing {yaml_path} (merge target)")

    print(f"done: {n_img} images, {n_box} boxes written to {out}/ "
          f"({skipped} boxes skipped — unmapped label or bad geometry)")


if __name__ == "__main__":
    main()
