"""Fine-tunes only the decoder with LoRA (the encoder is unchanged).

  python finetune/train.py --out run1 [--epochs 3] [--batch 16] [--lr 2e-4] [--rank 16]

The input is what prepare.py built (ft/enc.f16 and ft/train-meta.jsonl).
- Synthesized utterances with terms: trained with the generated sentence (Latin spellings) as the reference
- Real voices and synthesized utterances without terms: trained with the base model's own transcript as the reference (to keep its
  behavior). The next-token distribution is also pulled toward the base model (--kd; keeps not only the single correct token but also
  how the model hesitates)
- Some utterances get a vocabulary hint in the same form as the app (「語、語、語。」) in front, to keep the behavior with hints.
  Utterances without terms get hints of unrelated words (so that unrelated hints do not change the transcript)
After training, the model with LoRA merged into the base weights is saved to <out>/merged (export.sh converts it to the whisper.cpp format).
"""
import argparse
import json
import math
import os
import random
import subprocess
import sys
import time

# GPU memory limit (as a share of the recommended working set). Going over stops with an error before swapping slows everything down
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.45")
os.environ.setdefault("PYTORCH_MPS_LOW_WATERMARK_RATIO", "0.25")

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from common import BASE_MODEL, EOT, LANG_JA, ROOT, SOT, SOT_PREV, TRANSCRIBE

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--epochs", type=float, default=3)
ap.add_argument("--batch", type=int, default=16)
ap.add_argument("--lr", type=float, default=2e-4)
ap.add_argument("--rank", type=int, default=16)
ap.add_argument("--alpha", type=float, default=32)
ap.add_argument("--dropout", type=float, default=0.05)
ap.add_argument("--targets", default="attn,fc", help="layers to attach LoRA to: attn (the 4 attention matrices), fc (the 2 fully connected ones)")
ap.add_argument("--prompt-rate", type=float, default=0.15, help="share of utterances that get a vocabulary hint in front")
ap.add_argument("--real-weight", type=float, default=1.0, help="loss weight of utterances whose reference is the base model's transcript (real voices and synthesized speech without terms)")
ap.add_argument("--kd", type=float, default=1.0, help="weight of the loss that pulls toward the base model's distribution (0 disables it)")
ap.add_argument("--val", type=float, default=0.04, help="share held out for validation")
ap.add_argument("--max-real", type=int, default=0, help="limit real-voice utterances to this many (0 uses all)")
ap.add_argument("--no-real", action="store_true")
ap.add_argument("--seed", type=int, default=1)
args = ap.parse_args()

from transformers import WhisperForConditionalGeneration, WhisperTokenizer  # noqa: E402

random.seed(args.seed)
torch.manual_seed(args.seed)
device = "mps" if torch.backends.mps.is_available() else "cpu"
out_dir = os.path.join(ROOT, args.out)
os.makedirs(out_dir, exist_ok=True)
tok = WhisperTokenizer.from_pretrained(BASE_MODEL, language="japanese", task="transcribe")

# --- Data
meta = [json.loads(l) for l in open(os.path.join(ROOT, "train-meta.jsonl"), encoding="utf-8")]
enc = np.load(os.path.join(ROOT, "enc.f16"), mmap_mode="r")
# Utterances whose reference is the base model's transcript
PSEUDO = ("real", "plain")
if args.no_real:
    meta = [m for m in meta if m["kind"] not in PSEUDO]
elif args.max_real:
    # Limit only the real voices (synthesized speech without terms comes before real voices in the list, so limiting both together would leave no real voices)
    keep = set(m["i"] for m in [m for m in meta if m["kind"] == "real"][: args.max_real])
    meta = [m for m in meta if m["kind"] != "real" or m["i"] in keep]
meta = [m for m in meta if m["labels"] and len(m["labels"]) <= 300]
rng = random.Random(args.seed)
rng.shuffle(meta)
n_val = max(8, int(len(meta) * args.val))
# Validation utterances are only for watching training progress (not for model selection).
# Parts of joined utterances overlap with training data, so these are not numbers on fully separate data. Adoption is decided by finetune/eval.sh
val, train = meta[:n_val], meta[n_val:]
all_terms = sorted({t for m in meta for t in m["terms"]})
print(f"{len(train)} training, {len(val)} validation, {len(all_terms)} terms, device {device}", flush=True)

PREFIX = [SOT, LANG_JA, TRANSCRIBE]


def hint_ids(m: dict) -> list[int]:
    """Vocabulary hint in the same form as the app (「語、語、語。」). Mixes the utterance's terms with unrelated ones."""
    others = rng.sample(all_terms, k=min(len(all_terms), rng.randint(2, 8)))
    words = list(dict.fromkeys(m["terms"] + others))
    rng.shuffle(words)
    return [SOT_PREV] + tok("、".join(words) + "。", add_special_tokens=False).input_ids


def free_gpu() -> None:
    """Releases GPU memory no longer in use. Batch sizes differ, so without this the allocations keep growing (they went past 12 GB)."""
    if device == "mps":
        torch.mps.empty_cache()


def pad_len(n: int) -> int:
    return (n + 31) // 32 * 32


# Maximum number of positions per step (utterances × length). The vocabulary has about 50,000 tokens, so the number of positions drives memory use
TOKEN_BUDGET = args.batch * 64


def batches_of(ms: list[dict], shuffle: bool) -> list[list[dict]]:
    """Groups utterances of similar length into batches. Batches of long utterances hold fewer utterances."""
    order = list(range(len(ms)))
    if shuffle:
        rng.shuffle(order)
    out: list[list[int]] = []
    chunk = args.batch * 50
    for c0 in range(0, len(order), chunk):
        cur: list[int] = []
        for i in sorted(order[c0 : c0 + chunk], key=lambda k: len(ms[k]["labels"])):
            cur.append(i)
            # Sorted, so the last utterance added is the longest
            if len(cur) >= args.batch or (len(cur) + 1) * pad_len(len(ms[i]["labels"]) + 3) > TOKEN_BUDGET:
                out.append(cur)
                cur = []
        if cur:
            out.append(cur)
    if shuffle:
        rng.shuffle(out)
    return [[ms[i] for i in b] for b in out]


def make_batch(ms: list[dict], with_prompt: bool):
    ins, tgts, ws, kd = [], [], [], []
    for m in ms:
        labels = m["labels"]
        pre = hint_ids(m) if with_prompt else []
        ins.append(pre + PREFIX + labels[:-1])
        tgts.append([-100] * (len(pre) + 2) + labels)
        ws.append(args.real_weight if m["kind"] in PSEUDO else 1.0)
        kd.append(m["kind"] in PSEUDO)
    # Pad lengths to multiples of 32 (GPU memory reuses allocations of the same size; a different length every time is not reused and grows)
    L = pad_len(max(len(x) for x in ins))
    x = torch.full((len(ms), L), EOT, dtype=torch.long)
    y = torch.full((len(ms), L), -100, dtype=torch.long)
    for i, (a, b) in enumerate(zip(ins, tgts)):
        x[i, : len(a)] = torch.tensor(a)
        y[i, : len(b)] = torch.tensor(b)
    idx = sorted(range(len(ms)), key=lambda k: ms[k]["i"])
    feats = torch.from_numpy(np.stack([enc[ms[k]["i"]] for k in idx]).astype(np.float32))
    order = torch.tensor(idx)
    return feats.to(device), x[order].to(device), y[order].to(device), torch.tensor(ws)[order].to(device), torch.tensor(kd)[order].to(device)


# --- Model and LoRA
model = WhisperForConditionalGeneration.from_pretrained(BASE_MODEL, torch_dtype=torch.float32)
for p in model.parameters():
    p.requires_grad_(False)
# The encoder is not used (its output is saved), so drop it. 80% of the weights are the encoder, and keeping it uses 2.5 GB.
# After training, the base model is reloaded and LoRA is merged into it (merge.py)
model.model.encoder = nn.Identity()
model.model.decoder.to(device)
model.proj_out.to(device)


class LoRALinear(nn.Module):
    def __init__(self, base: nn.Linear, r: int, alpha: float, dropout: float):
        super().__init__()
        self.base = base
        self.a = nn.Parameter(torch.empty(r, base.in_features))
        self.b = nn.Parameter(torch.zeros(base.out_features, r))
        nn.init.kaiming_uniform_(self.a, a=math.sqrt(5))
        self.scale = alpha / r
        self.drop = nn.Dropout(dropout)
        # When False, it behaves as the base model (used to get the base model's distribution)
        self.enabled = True

    def forward(self, x):
        if not self.enabled:
            return self.base(x)
        return self.base(x) + F.linear(F.linear(self.drop(x), self.a), self.b) * self.scale

    def merge(self) -> nn.Linear:
        with torch.no_grad():
            self.base.weight += (self.b @ self.a) * self.scale
        return self.base


want = set(args.targets.split(","))
names = []
for li, layer in enumerate(model.model.decoder.layers):
    if "attn" in want:
        for att in ("self_attn", "encoder_attn"):
            for proj in ("q_proj", "k_proj", "v_proj", "out_proj"):
                names.append((getattr(layer, att), proj, f"{li}.{att}.{proj}"))
    if "fc" in want:
        for fc in ("fc1", "fc2"):
            names.append((layer, fc, f"{li}.{fc}"))
lora = []
for parent, attr, name in names:
    mod = LoRALinear(getattr(parent, attr), args.rank, args.alpha, args.dropout).to(device)
    setattr(parent, attr, mod)
    lora.append((parent, attr, mod))
params = [p for _, _, m in lora for p in (m.a, m.b)]
print(f"{len(lora)} matrices with LoRA, {sum(p.numel() for p in params) / 1e6:.2f}M trainable parameters", flush=True)


def loss_of(feats, x, y, w, kd):
    logits = model(encoder_outputs=(feats,), decoder_input_ids=x).logits
    per = F.cross_entropy(logits.transpose(1, 2), y, ignore_index=-100, reduction="none")
    mask = (y != -100).float()
    per_utt = (per * mask).sum(1) / mask.sum(1).clamp(min=1)
    # Do not divide by zero for a batch whose weights sum to 0 (with --real-weight 0, a batch of only utterances whose reference is the base model's transcript)
    loss = (per_utt * w).sum() / w.sum().clamp(min=1e-8)
    kl = torch.zeros((), device=device)
    if args.kd > 0 and bool(kd.any()):
        # Pull toward the next-token distribution of the base model (with LoRA disabled)
        with torch.no_grad():
            for _, _, m in lora:
                m.enabled = False
            teacher = model(encoder_outputs=(feats[kd],), decoder_input_ids=x[kd]).logits
            for _, _, m in lora:
                m.enabled = True
        t = F.softmax(teacher, dim=-1)
        per_tok = (t * (torch.log(t.clamp(min=1e-9)) - F.log_softmax(logits[kd], dim=-1))).sum(-1)
        mk = mask[kd]
        kl = (per_tok * mk).sum() / mk.sum().clamp(min=1)
        loss = loss + args.kd * kl * (float(kd.sum()) / len(kd))
    return loss, logits, kl


@torch.no_grad()
def evaluate() -> dict:
    model.eval()
    by: dict[str, list[float]] = {}
    hit = tot = 0
    for ms in batches_of(val, shuffle=False):
        feats, x, y, w, _ = make_batch(ms, with_prompt=False)
        logits = model(encoder_outputs=(feats,), decoder_input_ids=x).logits
        per = F.cross_entropy(logits.transpose(1, 2), y, ignore_index=-100, reduction="none")
        mask = y != -100
        per_utt = ((per * mask).sum(1) / mask.sum(1).clamp(min=1)).tolist()
        idx = sorted(range(len(ms)), key=lambda k: ms[k]["i"])
        for k, v in zip(idx, per_utt):
            kind = ms[k]["kind"]
            by.setdefault(kind if kind in ("real", "plain", "combo", "term") else "synth", []).append(v)
        hit += int(((logits.argmax(-1) == y) & mask).sum())
        tot += int(mask.sum())
        del feats, x, y, logits, per, mask
        free_gpu()
    model.train()
    return {**{k: round(sum(v) / len(v), 4) for k, v in by.items()}, "tokenAcc": round(hit / max(1, tot), 4)}


opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.0)
steps = int(len(batches_of(train, shuffle=False)) * args.epochs)
warm = max(10, steps // 20)
sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / max(1, steps)))))
log = {"args": vars(args), "before": evaluate(), "steps": []}
print(f"Before training: {log['before']} ({steps} steps)", flush=True)
model.train()
t0 = time.time()
step = 0
run = 0.0
run_kl = 0.0
while step < steps:
    for ms in batches_of(train, shuffle=True):
        if step >= steps:
            break
        # Whether to add a vocabulary hint is decided per batch (it makes sequences longer, so it is the same within a batch).
        # Batches with a hint hold fewer utterances to make up for the extra length
        use_prompt = rng.random() < args.prompt_rate
        if use_prompt:
            fit = TOKEN_BUDGET // pad_len(max(len(m["labels"]) for m in ms) + 3 + 64)
            ms = ms[: max(2, fit)]
        feats, x, y, w, kd = make_batch(ms, with_prompt=use_prompt)
        loss, _, kl = loss_of(feats, x, y, w, kd)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(params, 1.0)
        opt.step()
        sched.step()
        step += 1
        run = loss.item() if step == 1 else run * 0.95 + loss.item() * 0.05
        run_kl = kl.item() if step == 1 else run_kl * 0.95 + kl.item() * 0.05
        del feats, x, y, w, kd, loss
        free_gpu()
        if step % 50 == 0 or step == steps:
            rec = {"step": step, "loss": round(run, 4), "kl": round(run_kl, 4), "sec": round(time.time() - t0)}
            if step % 200 == 0 or step == steps:
                rec["val"] = evaluate()
            log["steps"].append(rec)
            print(rec, flush=True)

log["after"] = evaluate()
print(f"After training: {log['after']}, {(time.time() - t0) / 60:.1f} min", flush=True)
torch.save({n: (m.a.detach().cpu(), m.b.detach().cpu()) for (_, _, n), (_, _, m) in zip(names, lora)}, os.path.join(out_dir, "lora.pt"))
json.dump(log, open(os.path.join(out_dir, "train-log.json"), "w"), ensure_ascii=False, indent=1)

# Merge LoRA into the base weights and save (the encoder was dropped, so the base model is reloaded)
del model, opt, params, lora
free_gpu()
subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "merge.py"), "--run", args.out, "--scale", "1", "--out", args.out], check=True)
