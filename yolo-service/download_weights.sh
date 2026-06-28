#!/bin/bash
# Run this ONCE after first Railway deploy to download OmniParser weights.
# Screen2AX downloads automatically via hf_hub_download in main.py.
mkdir -p weights/icon_detect
huggingface-cli download microsoft/OmniParser-v2.0 \
  "icon_detect/model.pt" \
  --local-dir weights
echo "OmniParser weights downloaded."
