"""Shared parts for fine-tuning (audio loading, locations, token IDs)."""
import os
import struct

import numpy as np

ROOT = os.path.expanduser(os.environ.get("LONGHAND_FT_ROOT", "~/longhand-eval/ft"))
BASE_MODEL = os.path.expanduser(os.environ.get("LONGHAND_FT_BASE", "~/longhand-eval/exp/models/whisper-large-v3-turbo"))
FLEURS = os.path.expanduser("~/longhand-eval/public/fleurs-ja")

SR = 16000
# Shape of the encoder output (30-second window)
FRAMES = 1500
DIM = 1280

# Token IDs of openai/whisper-large-v3-turbo (checked with the tokenizer)
SOT = 50258
LANG_JA = 50266
TRANSCRIBE = 50360
SOT_PREV = 50362
NO_TIMESTAMPS = 50364
TS_BEGIN = 50365  # <|0.00|>, in 0.02-second steps up to <|30.00|> = 51865
TS_END = 51865
EOT = 50257


def read_wav(path: str) -> np.ndarray:
    """Reads a 16 kHz WAV (16-bit integer or 32-bit float) as mono float32."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError(f"Not a WAV file: {path}")
    pos = 12
    fmt = None
    pcm = None
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4]
        size = struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            tag, ch, sr, _, _, bits = struct.unpack("<HHIIHH", body[:16])
            if tag == 0xFFFE and len(body) >= 26:
                tag = struct.unpack("<H", body[24:26])[0]
            fmt = (tag, ch, sr, bits)
        elif cid == b"data":
            pcm = body
        pos += 8 + size + (size & 1)
    if fmt is None or pcm is None:
        raise ValueError(f"Cannot read the WAV contents: {path}")
    tag, ch, sr, bits = fmt
    if sr != SR:
        raise ValueError(f"Not 16 kHz ({sr}): {path}")
    if tag == 1 and bits == 16:
        x = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    elif tag == 3 and bits == 32:
        x = np.frombuffer(pcm, dtype="<f4").astype(np.float32)
    else:
        raise ValueError(f"Unsupported format (tag={tag}, bits={bits}): {path}")
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x
