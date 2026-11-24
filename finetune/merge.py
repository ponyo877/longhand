"""学習した LoRA を、強さを変えて元の重みに足し込む（学習し直さずに、調整の強さを弱めた版を作る）。

  python finetune/merge.py --run run1 --scale 0.5 --out run1-s050

強さ 1 は train.py が保存した merged と同じ、強さ 0 は元のモデルと同じになる。
元の重みと微調整した重みのあいだを取ると、元のデータでの動きを保ちやすい（WiSE-FT の考え方）。
"""
import argparse
import json
import os
import shutil

import torch

from common import BASE_MODEL, ROOT

ap = argparse.ArgumentParser()
ap.add_argument("--run", required=True, help="train.py の --out に渡した名前")
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
print(f"保存: {merged}（LoRA {len(lora)} 個、強さ {args.scale}）")
