"""デコーダだけを LoRA で微調整する（エンコーダは変えない）。

  python finetune/train.py --out run1 [--epochs 3] [--batch 16] [--lr 2e-4] [--rank 16]

入力は prepare.py が作ったもの（ft/enc.f16 と ft/train-meta.jsonl）。
- 用語を入れた合成音声の発話: 作った文（英字の綴り）を正解にして学習する
- 本物の声と、用語のない合成音声の発話: 元のモデル自身の書き起こしを正解にして学習する（元の動きを保つため）。
  さらに、次の語の確からしさの分布も、元のモデルに近づける（--kd。正解の 1 語だけでなく、迷い方も保つ）
- 一部の発話には、アプリと同じ形の語彙ヒント（「語、語、語。」）を前に付ける。ヒントがあるときの動きを保つため。
  用語のない発話には、関係のない語のヒントを付ける（関係のないヒントで、書き起こしが変わらないように）
学習が終わったら、LoRA を元の重みに足し込んだモデルを <out>/merged に保存する（export.sh で whisper.cpp の形式に変える）。
"""
import argparse
import json
import math
import os
import random
import subprocess
import sys
import time

# GPU のメモリの上限（推奨の作業領域に対する割合）。超えたら、スワップで遅くなる前にエラーで止まる
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
ap.add_argument("--targets", default="attn,fc", help="LoRA を付ける層。attn（注意の 4 つの行列）、fc（全結合の 2 つ）")
ap.add_argument("--prompt-rate", type=float, default=0.15, help="語彙ヒントを前に付ける発話の割合")
ap.add_argument("--real-weight", type=float, default=1.0, help="元のモデルの書き起こしを正解にした発話（本物の声と、用語のない合成音声）の損失の重み")
ap.add_argument("--kd", type=float, default=1.0, help="元のモデルの分布に近づける損失の重み（0 なら使わない）")
ap.add_argument("--val", type=float, default=0.04, help="確認用に取り分ける割合")
ap.add_argument("--max-real", type=int, default=0, help="本物の声の発話を、この数までにする（0 なら全部）")
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

# --- データ
meta = [json.loads(l) for l in open(os.path.join(ROOT, "train-meta.jsonl"), encoding="utf-8")]
enc = np.load(os.path.join(ROOT, "enc.f16"), mmap_mode="r")
# 元のモデルの書き起こしを正解にした発話
PSEUDO = ("real", "plain")
if args.no_real:
    meta = [m for m in meta if m["kind"] not in PSEUDO]
elif args.max_real:
    # 数を絞るのは本物の声だけ（用語のない合成音声は、一覧で本物の声より前に並んでいるので、まとめて絞ると本物の声が残らない）
    keep = set(m["i"] for m in [m for m in meta if m["kind"] == "real"][: args.max_real])
    meta = [m for m in meta if m["kind"] != "real" or m["i"] in keep]
meta = [m for m in meta if m["labels"] and len(m["labels"]) <= 300]
rng = random.Random(args.seed)
rng.shuffle(meta)
n_val = max(8, int(len(meta) * args.val))
# 確認用の発話は、学習の途中の様子を見るためだけに使う（モデルの選択には使わない）。
# つないだ発話の部品は学習用と重なるので、まったく別のデータでの値ではない。採否は finetune/eval.sh の結果で決める
val, train = meta[:n_val], meta[n_val:]
all_terms = sorted({t for m in meta for t in m["terms"]})
print(f"学習 {len(train)} 件、確認 {len(val)} 件、用語 {len(all_terms)} 語、装置 {device}", flush=True)

PREFIX = [SOT, LANG_JA, TRANSCRIBE]


def hint_ids(m: dict) -> list[int]:
    """アプリと同じ形の語彙ヒント（「語、語、語。」）。その発話の語と、関係のない語を混ぜる。"""
    others = rng.sample(all_terms, k=min(len(all_terms), rng.randint(2, 8)))
    words = list(dict.fromkeys(m["terms"] + others))
    rng.shuffle(words)
    return [SOT_PREV] + tok("、".join(words) + "。", add_special_tokens=False).input_ids


def free_gpu() -> None:
    """使い終わった GPU のメモリを返す。組ごとに大きさが違うので、返さないと確保したまま増えていく（12 GB を超えた）。"""
    if device == "mps":
        torch.mps.empty_cache()


def pad_len(n: int) -> int:
    return (n + 31) // 32 * 32


# 1 回に処理する位置の数の上限（発話の数 × 長さ）。語彙が約 5 万あるので、位置の数がそのままメモリに効く
TOKEN_BUDGET = args.batch * 64


def batches_of(ms: list[dict], shuffle: bool) -> list[list[dict]]:
    """長さの近い発話を同じ組にする。長い発話の組は、発話の数を減らす。"""
    order = list(range(len(ms)))
    if shuffle:
        rng.shuffle(order)
    out: list[list[int]] = []
    chunk = args.batch * 50
    for c0 in range(0, len(order), chunk):
        cur: list[int] = []
        for i in sorted(order[c0 : c0 + chunk], key=lambda k: len(ms[k]["labels"])):
            cur.append(i)
            # 並べ替えてあるので、最後に足した発話がいちばん長い
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
    # 長さを 32 きざみにそろえる（GPU のメモリは、同じ大きさの確保を使い回す。毎回ちがう長さだと、使い回されずに膨らむ）
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


# --- モデルと LoRA
model = WhisperForConditionalGeneration.from_pretrained(BASE_MODEL, torch_dtype=torch.float32)
for p in model.parameters():
    p.requires_grad_(False)
# エンコーダは使わない（出力を保存してある）ので、捨てる。重みの 8 割はエンコーダで、持っていると 2.5 GB を使う。
# 学習の後は、元のモデルを読み直して LoRA を足し込む（merge.py）
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
        # False にすると、元のモデルのまま動く（元のモデルの分布を取るときに使う）
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
print(f"LoRA を付けた行列 {len(lora)} 個、学習するパラメータ {sum(p.numel() for p in params) / 1e6:.2f}M", flush=True)


def loss_of(feats, x, y, w, kd):
    logits = model(encoder_outputs=(feats,), decoder_input_ids=x).logits
    per = F.cross_entropy(logits.transpose(1, 2), y, ignore_index=-100, reduction="none")
    mask = (y != -100).float()
    per_utt = (per * mask).sum(1) / mask.sum(1).clamp(min=1)
    # 重みの合計が 0 の組（--real-weight 0 で、元のモデルの書き起こしを正解にした発話だけの組）でも、0 で割らない
    loss = (per_utt * w).sum() / w.sum().clamp(min=1e-8)
    kl = torch.zeros((), device=device)
    if args.kd > 0 and bool(kd.any()):
        # 元のモデル（LoRA を外した状態）の、次の語の分布に近づける
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
print(f"学習の前: {log['before']}（{steps} ステップ）", flush=True)
model.train()
t0 = time.time()
step = 0
run = 0.0
run_kl = 0.0
while step < steps:
    for ms in batches_of(train, shuffle=True):
        if step >= steps:
            break
        # 語彙ヒントは、組ごとに付けるかどうかを決める（付けると長くなるので、同じ組の中でそろえる）。
        # 付ける組は、長くなる分だけ発話を減らす
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
print(f"学習の後: {log['after']}、{(time.time() - t0) / 60:.1f} 分", flush=True)
torch.save({n: (m.a.detach().cpu(), m.b.detach().cpu()) for (_, _, n), (_, _, m) in zip(names, lora)}, os.path.join(out_dir, "lora.pt"))
json.dump(log, open(os.path.join(out_dir, "train-log.json"), "w"), ensure_ascii=False, indent=1)

# LoRA を元の重みに足し込んで保存する（エンコーダを捨てたので、元のモデルを読み直す）
del model, opt, params, lora
free_gpu()
subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "merge.py"), "--run", args.out, "--scale", "1", "--out", args.out], check=True)
