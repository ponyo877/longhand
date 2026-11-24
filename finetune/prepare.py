"""微調整の準備: 学習に使う発話の一覧を作り、エンコーダの出力を保存し、時刻の印（タイムスタンプ）と、元のモデルの書き起こしを付ける。

  python finetune/prepare.py [--fleurs 0] [--combos 800] [--batch 8] [--limit N]

発話の種類と、正解の決め方:
- term、loanword、general（合成音声。ft/manifest.jsonl）: 正解は作った文。文の前後の時刻の印だけ、元のモデルに決めさせる
- plain（合成音声。公開データの文を読み上げたもの）と real（公開データ FLEURS の学習用の本物の声）:
  正解は、元のモデル自身の書き起こし（時刻の印も含む）。用語のない発話での動きを、元のモデルのまま保つために使う。
  公開データの正解の文は学習に使わないので、公開データでの評価が甘くならない
- combo: 上の発話を 2〜3 個つないだもの。長い発話や、複数の文の発話でも、文を飛ばさずに書き起こすように入れる

音声は、アプリと同じやり方で前後の無音を切り落としてから使う（ワーカーと同じ VAD、同じ余白）。
切り落とさずに学習すると、アプリでは「話し始めから音がある発話」を合成音声の発話と同じように扱い、長い発話の前半を飛ばすことがあった。

エンコーダは学習しないので、出力を 1 回だけ計算して保存する（ft/enc.f16、1 件あたり約 3.8 MB）。
"""
import argparse
import json
import os
import random
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch

from common import BASE_MODEL, DIM, EOT, FLEURS, FRAMES, LANG_JA, ROOT, SOT, SR, TRANSCRIBE, TS_BEGIN, TS_END, read_wav

ap = argparse.ArgumentParser()
ap.add_argument("--fleurs", type=int, default=0, help="公開データから使う発話の数（0 なら、使えるものすべて）")
ap.add_argument("--fleurs-max-sec", type=float, default=22.0)
ap.add_argument("--combos", type=int, default=800, help="発話をつないで作る発話の数")
ap.add_argument("--batch", type=int, default=8)
ap.add_argument("--limit", type=int, default=0, help="動作確認用。合成音声と公開データを、それぞれこの数までにする")
ap.add_argument("--no-trim", action="store_true", help="前後の無音を切り落とさない（比較用）")
ap.add_argument("--fp32", action="store_true", help="単精度で計算する。既定の半精度は、この Mac でエンコーダが 5 倍以上速い（1 件 2.6 秒が 0.5 秒）")
ap.add_argument("--vad-bin", default="~/longhand-eval/exp/wcpp-build/bin/whisper-vad-speech-segments")
ap.add_argument("--vad-model", default="~/longhand-eval/models/whisper/ggml-silero-v6.2.0.bin")
args = ap.parse_args()

# ワーカー（asr/whisper/src/main.cpp）と同じ値
VAD_ARGS = ["-vt", "0.5", "-vspd", "250", "-vsd", "300", "-vp", "30", "-np"]
VAD_PAD_SEC = 0.3
PSEUDO = ("real", "plain")

# --- 発話の一覧
items = []
with open(os.path.join(ROOT, "manifest.jsonl"), encoding="utf-8") as f:
    for line in f:
        r = json.loads(line)
        items.append({"id": r["id"], "path": os.path.join(ROOT, r["audio"]), "kind": r["kind"], "text": r["text"], "terms": r["terms"]})
if args.limit:
    by_kind: dict[str, list] = {}
    for x in items:
        by_kind.setdefault(x["kind"], []).append(x)
    items = [x for xs in by_kind.values() for x in xs[: args.limit]]

rng = random.Random(20261123)
fleurs = []
with open(os.path.join(FLEURS, "train.tsv"), encoding="utf-8") as f:
    for line in f:
        c = line.rstrip("\n").split("\t")
        if len(c) < 6:
            continue
        sec = int(c[5]) / SR
        if 1.0 <= sec <= args.fleurs_max_sec:
            fleurs.append({"id": f"fleurs-train-{c[1][:-4]}", "path": os.path.join(FLEURS, "extract", "train", c[1]), "kind": "real", "text": "", "terms": []})
rng.shuffle(fleurs)
fleurs = [x for x in fleurs if os.path.exists(x["path"])]
fleurs = fleurs[: (args.limit or args.fleurs or len(fleurs))]
items += fleurs


# --- 前後の無音の切り落とし（アプリと同じ VAD。結果は ft/vad.jsonl に保存して、次からは計算しない）
vad_path = os.path.join(ROOT, "vad.jsonl")
vad_cache: dict[str, list[float] | None] = {}
if os.path.exists(vad_path):
    for line in open(vad_path, encoding="utf-8"):
        r = json.loads(line)
        vad_cache[r["path"]] = r["range"]


def vad_range(path: str) -> list[float] | None:
    """発話の始まりと終わり（秒）。発話が無ければ None。"""
    p = subprocess.run([os.path.expanduser(args.vad_bin), "-vm", os.path.expanduser(args.vad_model), "-f", path, *VAD_ARGS], capture_output=True, text=True, timeout=120)
    # 失敗（モデルが無い、音声を読めない）を「発話なし」として保存すると、直した後も除かれたままになる
    if p.returncode != 0:
        raise RuntimeError(f"無音の切り落としに失敗しました（終了コード {p.returncode}）: {path}\n{p.stderr.strip()[-300:]}")
    segs = [(float(a) / 100, float(b) / 100) for a, b in re.findall(r"start = ([\d.]+), end = ([\d.]+)", p.stdout)]
    return [segs[0][0], segs[-1][1]] if segs else None


if not args.no_trim:
    todo = [x["path"] for x in items if x["path"] not in vad_cache]
    for need in (args.vad_bin, args.vad_model):
        if todo and not os.path.exists(os.path.expanduser(need)):
            sys.exit(f"無音の切り落としに使うファイルがありません: {need}")
    if todo:
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=6) as ex, open(vad_path, "a", encoding="utf-8") as f:
            for i, (p, r) in enumerate(zip(todo, ex.map(vad_range, todo))):
                vad_cache[p] = r
                f.write(json.dumps({"path": p, "range": r}) + "\n")
                if (i + 1) % 1000 == 0:
                    print(f"無音の切り落としの範囲 {i + 1}/{len(todo)}  {time.time() - t0:.0f} 秒", flush=True)
    before = len(items)
    items = [x for x in items if vad_cache.get(x["path"])]
    if len(items) < before:
        print(f"発話が見つからなかった {before - len(items)} 件を除いた", flush=True)


def load(x: dict) -> np.ndarray:
    """音声を読み、アプリと同じ余白で前後の無音を切り落とす。"""
    a = read_wav(x["path"])
    if args.no_trim:
        return a
    first, last = vad_cache[x["path"]]
    s0 = int(max(0.0, (first - VAD_PAD_SEC) * SR))
    s1 = int(min(float(len(a)), (last + VAD_PAD_SEC) * SR))
    return a[s0:s1] if s1 > s0 else a


from transformers import WhisperFeatureExtractor, WhisperForConditionalGeneration, WhisperTokenizer  # noqa: E402

device = "mps" if torch.backends.mps.is_available() else "cpu"
fe = WhisperFeatureExtractor.from_pretrained(BASE_MODEL)
tok = WhisperTokenizer.from_pretrained(BASE_MODEL, language="japanese", task="transcribe")
dtype = torch.float32 if args.fp32 else torch.float16
model = WhisperForConditionalGeneration.from_pretrained(BASE_MODEL, torch_dtype=dtype).to(device).eval()

n_base = len(items)
N = n_base + args.combos
kinds: dict[str, int] = {}
for x in items:
    kinds[x["kind"]] = kinds.get(x["kind"], 0) + 1
print(f"発話 {N} 件（{kinds}、つないだ発話 {args.combos}）、装置 {device}", flush=True)

enc_path = os.path.join(ROOT, "enc.f16")
meta_path = os.path.join(ROOT, "train-meta.jsonl")
# 一覧は最後に書く。途中で止まったときに、前の一覧が新しい（書きかけの）エンコーダの出力を指さないように、先に消しておく
if os.path.exists(meta_path):
    os.remove(meta_path)
enc = np.lib.format.open_memmap(enc_path, mode="w+", dtype=np.float16, shape=(N, FRAMES, DIM))
prefix = [SOT, LANG_JA, TRANSCRIBE]


@torch.no_grad()
def ts_after(enc_out: torch.Tensor, seqs: list[list[int]], max_ts: int | None = None) -> list[int]:
    """それぞれの並びの次に来る時刻の印を、元のモデルに決めさせる（時刻の印の中で、いちばん確からしいもの）。"""
    L = max(len(s) for s in seqs)
    ids = torch.full((len(seqs), L), EOT, dtype=torch.long, device=device)
    for i, s in enumerate(seqs):
        ids[i, : len(s)] = torch.tensor(s, device=device)
    logits = model(encoder_outputs=(enc_out,), decoder_input_ids=ids).logits
    out = []
    for i, s in enumerate(seqs):
        row = logits[i, len(s) - 1, TS_BEGIN : TS_END + 1]
        if max_ts is not None:
            row = row[: max_ts + 1]
        out.append(int(row.argmax().item()) + TS_BEGIN)
    return out


@torch.no_grad()
def encode(audio: list[np.ndarray]) -> tuple[torch.Tensor, torch.Tensor]:
    feats = fe(audio, sampling_rate=SR, return_tensors="pt").input_features.to(device).to(dtype)
    return feats, model.model.encoder(feats).last_hidden_state


def text_of(labels: list[int]) -> str:
    return tok.decode([t for t in labels if t < EOT])


meta = []
t0 = time.time()

# --- 1 つずつの発話
for b0 in range(0, n_base, args.batch):
    batch = items[b0 : b0 + args.batch]
    audio = [load(x) for x in batch]
    for x, a in zip(batch, audio):
        x["sec"] = round(len(a) / SR, 2)
    feats, enc_out = encode(audio)
    enc[b0 : b0 + len(batch)] = enc_out.to(torch.float16).cpu().numpy()

    synth = [i for i, x in enumerate(batch) if x["kind"] not in PSEUDO]
    pseudo = [i for i, x in enumerate(batch) if x["kind"] in PSEUDO]
    labels: list[list[int] | None] = [None] * len(batch)
    if synth:
        e = enc_out[synth]
        text_ids = [tok(batch[i]["text"], add_special_tokens=False).input_ids for i in synth]
        # 文の頭の時刻（最初の 1 秒まで）と、文の終わりの時刻
        start = ts_after(e, [prefix for _ in synth], max_ts=50)
        end = ts_after(e, [prefix + [s] + t for s, t in zip(start, text_ids)])
        for k, i in enumerate(synth):
            # 終わりの時刻が、頭の時刻より前や、音声の長さより大きく後ろなら、音声の長さから決める
            dur_ts = TS_BEGIN + min(1500, int(round(batch[i]["sec"] / 0.02)))
            e_ts = end[k] if start[k] < end[k] <= dur_ts + 25 else dur_ts
            labels[i] = [start[k]] + text_ids[k] + [e_ts, EOT]
    if pseudo:
        with torch.no_grad():
            gen = model.generate(input_features=feats[pseudo], language="ja", task="transcribe", return_timestamps=True, num_beams=1, do_sample=False, max_new_tokens=440)
        seqs = gen["sequences"] if isinstance(gen, dict) else gen
        for k, i in enumerate(pseudo):
            ids = [int(t) for t in seqs[k].tolist()]
            # 先頭の印（書き起こしの始まり、言語、種類）と、末尾の詰め物を除く
            while ids and ids[0] in (SOT, LANG_JA, TRANSCRIBE):
                ids.pop(0)
            while ids and ids[-1] == EOT:
                ids.pop()
            labels[i] = ids + [EOT]
    for i, x in enumerate(batch):
        meta.append({"i": b0 + i, "id": x["id"], "kind": x["kind"], "sec": x["sec"], "terms": x["terms"], "labels": labels[i], "text": x["text"] if x["kind"] not in PSEUDO else text_of(labels[i])})
    done = b0 + len(batch)
    if done % (args.batch * 50) == 0 or done == n_base:
        el = time.time() - t0
        print(f"{done}/{N}  {el:.0f} 秒（残り約 {el / done * (N - done) / 60:.1f} 分）", flush=True)

# --- 発話をつないだ発話
# 部品にするのは、時刻の印で始まって時刻の印で終わる発話だけ（つないだあとも、時刻の印が対になる）
crng = random.Random(20261124)
by_kind = {}
for m, x in zip(meta, items):
    lab = m["labels"]
    if len(lab) >= 4 and lab[0] >= TS_BEGIN and lab[-2] >= TS_BEGIN and m["sec"] <= 14.0 and len(lab) <= 150:
        by_kind.setdefault("term" if m["kind"] == "term" else "pseudo" if m["kind"] in PSEUDO else "other", []).append((m, x))
weights = [("term", 0.45), ("pseudo", 0.45), ("other", 0.10)]
weights = [(k, w) for k, w in weights if by_kind.get(k)]


def pick_part():
    r = crng.random() * sum(w for _, w in weights)
    for k, w in weights:
        r -= w
        if r <= 0:
            return crng.choice(by_kind[k])
    return crng.choice(by_kind[weights[-1][0]])


combos = []
guard = 0
while len(combos) < args.combos and weights and guard < args.combos * 50:
    guard += 1
    parts = [pick_part() for _ in range(crng.choice([2, 2, 3]))]
    if len({m["id"] for m, _ in parts}) < len(parts):
        continue
    gaps = [crng.uniform(0.15, 0.7) for _ in parts[1:]]
    if sum(m["sec"] for m, _ in parts) + sum(gaps) > 27.5:
        continue
    combos.append((parts, gaps))

for c0 in range(0, len(combos), args.batch):
    chunk = combos[c0 : c0 + args.batch]
    audio = []
    rows = []
    for j, (parts, gaps) in enumerate(chunk):
        pieces = []
        labels: list[int] = []
        pos = 0
        for k, (m, x) in enumerate(parts):
            if k > 0:
                # 文のあいだの間。完全な無音にせず、ごく小さい雑音を入れる
                g = (np.random.default_rng(c0 + j * 7 + k).random(int(gaps[k - 1] * SR), dtype=np.float32) * 2 - 1) * 0.0005
                pieces.append(g)
                pos += len(g)
            a = load(x)
            shift = int(round(pos / SR / 0.02))
            # 時刻の印は、後ろへ進むだけにする。前の部分の終わりの時刻が音声より少し後ろに付いていると、
            # 短い間のあとの次の部分の頭が、それより前になることがある
            floor = max((t for t in labels if t >= TS_BEGIN), default=TS_BEGIN)
            labels += [min(TS_END, max(floor, t + shift)) if t >= TS_BEGIN else t for t in m["labels"][:-1]]
            pieces.append(a)
            pos += len(a)
        labels.append(EOT)
        audio.append(np.concatenate(pieces))
        rows.append({
            "i": n_base + c0 + j, "id": f"combo-{c0 + j:05d}", "kind": "combo", "sec": round(pos / SR, 2),
            "terms": sorted({t for m, _ in parts for t in m["terms"]}), "labels": labels, "text": text_of(labels), "parts": [m["id"] for m, _ in parts],
        })
    _, enc_out = encode(audio)
    enc[n_base + c0 : n_base + c0 + len(chunk)] = enc_out.to(torch.float16).cpu().numpy()
    meta += rows
    done = n_base + c0 + len(chunk)
    if (c0 // args.batch) % 25 == 24 or done == n_base + len(combos):
        el = time.time() - t0
        print(f"{done}/{N}  {el:.0f} 秒", flush=True)

enc.flush()
with open(meta_path, "w", encoding="utf-8") as f:
    for m in meta:
        f.write(json.dumps(m, ensure_ascii=False) + "\n")
print(f"終わり: {len(meta)} 件、{(time.time() - t0) / 60:.1f} 分、{os.path.getsize(enc_path) / 1e9:.1f} GB", flush=True)
