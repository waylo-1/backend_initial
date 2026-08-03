#!/usr/bin/env python3
"""Bulk-seed the icon caption vocabulary.

The YOLO service captions each detected box by matching its SigLIP embedding
against a list of icon CONCEPTS (name + descriptive phrase). The built-in list
in main.py (ICON_VOCAB) covers the common desktop/web icons; this script lets
you pour in a much larger, named icon dataset so the zero-shot captioner
recognises far more glyphs — no images or GPU needed, it's pure text concepts.

The vocabulary is TEXT ONLY. You are not uploading icon pictures — you are
telling SigLIP the NAMES of icons to look for. That is exactly what an icon
dataset with labelled names gives you.

Good, free, already-labelled sources (each is just a list of icon names):
  • Apple SF Symbols  — ~5000 names, the canonical macOS system icon set.
      Export from the SF Symbols.app (File > Export) or the `sf-symbols` list,
      or grab a names list such as SFSymbolsList. Names like "paperclip",
      "square.and.arrow.up" (share), "trash", "star.fill".
  • Google Material Symbols — ~3000 names (Google/web apps, incl. Gmail/Docs).
      https://github.com/google/material-design-icons -> the codepoints file is
      one "name codepoint" per line. Names like "attach_file", "format_bold".
  • Font Awesome — ~2000 names. Its icons.json/metadata lists every name.

Usage:
  # 1) Merge a newline-delimited names file into the persisted custom vocab
  #    (read at service startup by load_custom_vocab, then embedded):
  python seed_vocab.py sf_symbols_names.txt

  # 2) Same, but also embed live in a RUNNING YOLO service via its /vocab
  #    endpoint (slower — one HTTP call + re-embed per new concept). Point
  #    --post at the PYTHON service (default :8000), not the Node backend:
  python seed_vocab.py material_names.txt --post http://localhost:8000

  # 3) Merge several sources at once:
  python seed_vocab.py sf.txt material.txt fontawesome.txt

A names file is one icon name per line. SF-Symbols dotted names
("square.and.arrow.up") and Material snake_case ("attach_file") are split into
words automatically, so the phrase reads naturally ("a square and arrow up icon
in a user interface"). Blank lines and lines starting with # are ignored.

After seeding, restart / redeploy the YOLO service so build_icon_vocab()
re-embeds the enlarged list at startup (option 2 embeds immediately but is only
worth it for a handful of additions).
"""
import json
import os
import re
import sys
import urllib.request

VOCAB_PATH = os.path.join(os.path.dirname(__file__), "weights", "custom_vocab.json")

# Pure render-VARIANT qualifiers that appear as a TRAILING token on SF-Symbols
# names ("star.fill", "gear.circle.fill"). Stripped only from the end so the
# variant collapses onto its base concept — never mid-name, where the same word
# can be meaningful ("square.and.arrow.up", "rectangle.stack").
TRAILING_VARIANTS = {"fill", "outline", "regular", "solid", "light", "thin", "slash"}


def clean_name(raw: str) -> str:
    """Mirror the service's normalization: lowercase, words only, 3–40 chars.
    Keeps every word of the name intact (SF-Symbols dotted / Material snake_case
    both split on the separator) — only a trailing render variant is dropped."""
    # SF Symbols use dots, Material uses underscores/dashes — all become spaces.
    s = re.sub(r"[._\-]+", " ", raw.strip().lower())
    s = re.sub(r"[^a-z0-9 ]", "", s)
    words = [w for w in s.split() if w]
    while len(words) > 1 and words[-1] in TRAILING_VARIANTS:
        words.pop()
    s = " ".join(words).strip()
    return s[:40] if 3 <= len(s) <= 40 else ""


def phrase_for(name: str) -> str:
    return f"a {name} icon in a user interface"


def load_names(paths: list[str]) -> list[str]:
    names: list[str] = []
    for p in paths:
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                # Material codepoint lines are "name codepoint" — take the name.
                token = line.split()[0]
                n = clean_name(token)
                if n:
                    names.append(n)
    return names


def main() -> None:
    args = [a for a in sys.argv[1:]]
    post_url = None
    if "--post" in args:
        i = args.index("--post")
        post_url = args[i + 1].rstrip("/")
        del args[i : i + 2]
    if not args:
        print(__doc__)
        sys.exit(1)

    incoming = load_names(args)
    if not incoming:
        print("No usable names found in the given file(s).")
        sys.exit(1)

    # Merge with what's already persisted; de-dupe by name.
    existing: list = []
    if os.path.exists(VOCAB_PATH):
        with open(VOCAB_PATH, encoding="utf-8") as f:
            existing = [tuple(x) for x in json.load(f)]
    known = {n for n, _ in existing}

    added = 0
    for name in incoming:
        if name in known:
            continue
        existing.append([name, phrase_for(name)])
        known.add(name)
        added += 1

    os.makedirs(os.path.dirname(VOCAB_PATH), exist_ok=True)
    with open(VOCAB_PATH, "w", encoding="utf-8") as f:
        json.dump([list(x) for x in existing], f, indent=0)
    print(f"Seeded {added} new concept(s) → {VOCAB_PATH} (total {len(existing)}).")
    print("Restart / redeploy the YOLO service to embed them at startup.")

    if post_url:
        print(f"Also POSTing {added} concept(s) to {post_url}/vocab/add …")
        ok = 0
        for name in incoming:
            body = json.dumps({"name": name, "phrase": phrase_for(name)}).encode()
            req = urllib.request.Request(
                f"{post_url}/vocab", data=body,
                headers={"Content-Type": "application/json"},
            )
            try:
                urllib.request.urlopen(req, timeout=30)
                ok += 1
            except Exception as e:  # noqa: BLE001 — best-effort seeding
                print(f"  POST failed for '{name}': {e}")
        print(f"  live-embedded {ok}/{len(incoming)} via the running service.")


if __name__ == "__main__":
    main()
