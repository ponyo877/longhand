"""Fine-tuning preparation: builds the list of training utterances, saves the encoder outputs, and attaches timestamp tokens and the base model's transcripts.

  python finetune/prepare.py [--fleurs 0] [--combos 800] [--batch 8] [--limit N]

Utterance kinds and how their references are chosen:
- term, loanword, general (synthesized speech, ft/manifest.jsonl): the reference is the generated sentence. Only the timestamps before
  and after the sentence are chosen by the base model
- plain (synthesized speech reading public-data sentences) and real (real voices from the FLEURS training split):
  the reference is the base model's own transcript (including timestamps). Used to keep the base model's behavior on utterances
  without terms. The public data's reference sentences are not used for training, so evaluation on public data is not inflated
- combo: 2 to 3 of the utterances above joined together. Included so that long utterances and multi-sentence utterances are
  transcribed without skipping sentences

Audio is used after trimming leading and trailing silence the same way the app does (the same VAD and padding as the worker).
When trained without trimming, the app treated "utterances with sound from the very start" like synthesized utterances and sometimes
skipped the first half of long utterances.

The encoder is not trained, so its output is computed once and saved (ft/enc.f16, about 3.8 MB per utterance).
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
ap.add_argument("--fleurs", type=int, default=0, help="number of utterances to use from public data (0 uses all available)")
ap.add_argument("--fleurs-max-sec", type=float, default=22.0)
ap.add_argument("--combos", type=int, default=800, help="number of utterances made by joining utterances")
ap.add_argument("--batch", type=int, default=8)
ap.add_argument("--limit", type=int, default=0, help="for a quick check: limit synthesized speech and public data to this many each")
ap.add_argument("--no-trim", action="store_true", help="do not trim leading and trailing silence (for comparison)")
ap.add_argument("--fp32", action="store_true", help="compute in single precision. The default half precision makes the encoder over 5 times faster on this Mac (2.6 s per utterance becomes 0.5 s)")
ap.add_argument("--vad-bin", default="~/longhand-eval/exp/wcpp-build/bin/whisper-vad-speech-segments")
ap.add_argument("--vad-model", default="~/longhand-eval/models/whisper/ggml-silero-v6.2.0.bin")
args = ap.parse_args()

# The same values as the worker (asr/whisper/src/main.cpp)
VAD_ARGS = ["-vt", "0.5", "-vspd", "250", "-vsd", "300", "-vp", "30", "-np"]
VAD_PAD_SEC = 0.3
PSEUDO = ("real", "plain")

# --- List of utterances
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


# --- Trimming leading and trailing silence (the same VAD as the app; results are saved to ft/vad.jsonl and not computed again)
vad_path = os.path.join(ROOT, "vad.jsonl")
vad_cache: dict[str, list[float] | None] = {}
if os.path.exists(vad_path):
    for line in open(vad_path, encoding="utf-8"):
        r = json.loads(line)
        vad_cache[r["path"]] = r["range"]


def vad_range(path: str) -> list[float] | None:
    """Start and end of speech (seconds), or None if there is no speech."""
    p = subprocess.run([os.path.expanduser(args.vad_bin), "-vm", os.path.expanduser(args.vad_model), "-f", path, *VAD_ARGS], capture_output=True, text=True, timeout=120)
    # Saving a failure (missing model, unreadable audio) as "no speech" would keep the utterance excluded even after the problem is fixed
    if p.returncode != 0:
        raise RuntimeError(f"Silence trimming failed (exit code {p.returncode}): {path}\n{p.stderr.strip()[-300:]}")
    segs = [(float(a) / 100, float(b) / 100) for a, b in re.findall(r"start = ([\d.]+), end = ([\d.]+)", p.stdout)]
    return [segs[0][0], segs[-1][1]] if segs else None


if not args.no_trim:
    todo = [x["path"] for x in items if x["path"] not in vad_cache]
    for need in (args.vad_bin, args.vad_model):
        if todo and not os.path.exists(os.path.expanduser(need)):
            sys.exit(f"File needed for silence trimming not found: {need}")
    if todo:
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=6) as ex, open(vad_path, "a", encoding="utf-8") as f:
            for i, (p, r) in enumerate(zip(todo, ex.map(vad_range, todo))):
                vad_cache[p] = r
                f.write(json.dumps({"path": p, "range": r}) + "\n")
                if (i + 1) % 1000 == 0:
                    print(f"Silence trimming ranges {i + 1}/{len(todo)}  {time.time() - t0:.0f} s", flush=True)
    before = len(items)
    items = [x for x in items if vad_cache.get(x["path"])]
    if len(items) < before:
        print(f"Removed {before - len(items)} utterances with no speech found", flush=True)


def load(x: dict) -> np.ndarray:
    """Reads audio and trims leading and trailing silence with the same padding as the app."""
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
print(f"{N} utterances ({kinds}, {args.combos} joined), device {device}", flush=True)

enc_path = os.path.join(ROOT, "enc.f16")
meta_path = os.path.join(ROOT, "train-meta.jsonl")
# The list is written last. Delete it first so that, if stopped midway, an old list does not point at new (partly written) encoder outputs
if os.path.exists(meta_path):
    os.remove(meta_path)
enc = np.lib.format.open_memmap(enc_path, mode="w+", dtype=np.float16, shape=(N, FRAMES, DIM))
prefix = [SOT, LANG_JA, TRANSCRIBE]


@torch.no_grad()
def ts_after(enc_out: torch.Tensor, seqs: list[list[int]], max_ts: int | None = None) -> list[int]:
    """Lets the base model choose the timestamp that follows each sequence (the most likely timestamp token)."""
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

# --- Single utterances
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
        # Timestamp at the start of the sentence (within the first second) and at its end
        start = ts_after(e, [prefix for _ in synth], max_ts=50)
        end = ts_after(e, [prefix + [s] + t for s, t in zip(start, text_ids)])
        for k, i in enumerate(synth):
            # If the end timestamp is before the start or well past the audio length, derive it from the audio length
            dur_ts = TS_BEGIN + min(1500, int(round(batch[i]["sec"] / 0.02)))
            e_ts = end[k] if start[k] < end[k] <= dur_ts + 25 else dur_ts
            labels[i] = [start[k]] + text_ids[k] + [e_ts, EOT]
    if pseudo:
        with torch.no_grad():
            gen = model.generate(input_features=feats[pseudo], language="ja", task="transcribe", return_timestamps=True, num_beams=1, do_sample=False, max_new_tokens=440)
        seqs = gen["sequences"] if isinstance(gen, dict) else gen
        for k, i in enumerate(pseudo):
            ids = [int(t) for t in seqs[k].tolist()]
            # Remove the leading tokens (start of transcript, language, task) and the trailing padding
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
        print(f"{done}/{N}  {el:.0f} s (about {el / done * (N - done) / 60:.1f} min left)", flush=True)

# --- Joined utterances
# Only utterances that start and end with a timestamp are used as parts (so timestamps stay paired after joining)
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
                # Gap between sentences. Not complete silence: add a very small noise
                g = (np.random.default_rng(c0 + j * 7 + k).random(int(gaps[k - 1] * SR), dtype=np.float32) * 2 - 1) * 0.0005
                pieces.append(g)
                pos += len(g)
            a = load(x)
            shift = int(round(pos / SR / 0.02))
            # Timestamps only move forward. If the previous part's end timestamp sits a little after its audio,
            # the start of the next part after a short gap could come before it
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
        print(f"{done}/{N}  {el:.0f} s", flush=True)

enc.flush()
with open(meta_path, "w", encoding="utf-8") as f:
    for m in meta:
        f.write(json.dumps(m, ensure_ascii=False) + "\n")
print(f"Done: {len(meta)} utterances, {(time.time() - t0) / 60:.1f} min, {os.path.getsize(enc_path) / 1e9:.1f} GB", flush=True)
