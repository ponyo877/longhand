"""Merges a trained LoRA into the base weights at a chosen scale (makes a weaker version of the tuning without retraining).

  python finetune/merge.py --run run1 --scale 0.5 --out run1-s050

Scale 1 equals the merged model train.py saved; scale 0 equals the base model.
Interpolating between the base and fine-tuned weights helps keep the behavior on the original data (the idea behind WiSE-FT).
"""
import argparse
import json
import os
import shutil

import torch

from common import BASE_MODEL, ROOT

ap = argparse.ArgumentParser()
ap.add_argument("--run", required=True, help="name passed to --out of train.py")
ap.add_argument("--scale", type=float, required=True)
ap.add_argument("--out", required=True)
args = ap.parse_args()

from transformers import WhisperForConditionalGeneration  # noqa: E402

src = os.path.join(ROOT, args.run)
log = json.load(open(os.path.join(src, "train-log.json")))
factor = log["args"]["alpha"] / log["args"]["rank"] * args.scale
lora = torch.load(os.path.join(src, "lora.pt"), map_location="cpu")
model = WhisperForConditionalGeneration.from_pretrained(BASE_MODEL, torch_dtype=torch.float32)
layers = model.model.decoder.layers
with torch.no_grad():
    for name, (a, b) in lora.items():
        li, *path = name.split(".")
        mod = layers[int(li)]
        for p in path:
            mod = getattr(mod, p)
        mod.weight += (b @ a) * factor
merged = os.path.join(ROOT, args.out, "merged")
os.makedirs(merged, exist_ok=True)
model.save_pretrained(merged)
for f in os.listdir(BASE_MODEL):
    if f != "model.safetensors" and os.path.isfile(os.path.join(BASE_MODEL, f)) and not os.path.exists(os.path.join(merged, f)):
        shutil.copy(os.path.join(BASE_MODEL, f), merged)
print(f"Saved: {merged} ({len(lora)} LoRA matrices, scale {args.scale})")
