#!/usr/bin/env bash
# Fetch the reference icon set for image-to-image icon labelling.
#
# We name a detected icon by the reference icon it most resembles (SigLIP
# image->image). The reference library is built at startup from ONE icon font +
# a "name codepoint" list — ~2000 named Material icons rendered on the fly, no
# giant PNG dataset needed. Run this once on the YOLO box, then restart the
# service so build_icon_reference() embeds them.
#
#   bash download_icon_font.sh
#   pm2 restart yolo-service      # (or however the service runs)
#
# You can also add your OWN reference icons instead of / on top of these: drop
# labelled PNGs in  reference_icons/<name>.png  (e.g. reference_icons/archive.png)
# and they take priority.
set -euo pipefail

DEST="weights/icon_font"
mkdir -p "$DEST"

BASE="https://raw.githubusercontent.com/google/material-design-icons/master/font"
echo "Downloading Material Icons font + codepoints to $DEST ..."
curl -fSL "$BASE/MaterialIcons-Regular.ttf"        -o "$DEST/MaterialIcons-Regular.ttf"
curl -fSL "$BASE/MaterialIcons-Regular.codepoints" -o "$DEST/MaterialIcons-Regular.codepoints"

COUNT=$(wc -l < "$DEST/MaterialIcons-Regular.codepoints" || echo "?")
echo "Done. $COUNT reference icons available."
echo "Restart the YOLO service; look for '[ICONREF] embedded N reference icons' in the logs."
