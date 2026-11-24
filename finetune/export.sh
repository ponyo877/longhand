#!/usr/bin/env bash
# Converts a fine-tuned model (<root>/<run>/merged) to the whisper.cpp format (ggml, 8-bit quantization).
#
#   finetune/export.sh run1          → ~/longhand-eval/models/whisper/ggml-turbo-ft-run1-q8_0.bin
#
# Prerequisites:
# - ~/longhand-eval/exp/venv has torch, transformers and openai-whisper installed
# - ~/longhand-eval/exp/wcpp-build/bin/whisper-quantize exists
#   (cmake -S asr/whisper/third_party/whisper.cpp -B ~/longhand-eval/exp/wcpp-build -DWHISPER_BUILD_EXAMPLES=ON && cmake --build … --target whisper-quantize)
# The base model converted the same way was confirmed to transcribe the same as the official ggml (docs/evaluation.md).
set -euo pipefail
RUN="${1:?give a run name}"
ROOT="${LONGHAND_FT_ROOT:-$HOME/longhand-eval/ft}"
EXP="$HOME/longhand-eval/exp"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$HOME/longhand-eval/models/whisper"
PY="$EXP/venv/bin/python"
WHISPER_PKG="$("$PY" -c "import whisper,os;print(os.path.dirname(os.path.dirname(whisper.__file__)))")"
TMP="$ROOT/$RUN/ggml"
mkdir -p "$TMP" "$OUT"
DEST="$OUT/ggml-turbo-ft-$RUN-q8_0.bin"
# Delete the previous conversion first, so that a failure midway does not leave an old model behind that then gets measured
rm -f "$TMP/ggml-model.bin" "$DEST"
LOG="$TMP/export.log"
if ! "$PY" "$REPO/asr/whisper/third_party/whisper.cpp/models/convert-h5-to-ggml.py" "$ROOT/$RUN/merged" "$WHISPER_PKG" "$TMP" >"$LOG" 2>&1 || [ ! -s "$TMP/ggml-model.bin" ]; then
  tail -n 20 "$LOG" >&2
  echo "Conversion to ggml failed (log: $LOG)" >&2
  exit 1
fi
if ! "$EXP/wcpp-build/bin/whisper-quantize" "$TMP/ggml-model.bin" "$DEST" q8_0 >>"$LOG" 2>&1 || [ ! -s "$DEST" ]; then
  tail -n 20 "$LOG" >&2
  rm -f "$DEST"
  echo "Quantization failed (log: $LOG)" >&2
  exit 1
fi
grep -E "quantize time" "$LOG" || true
rm -f "$TMP/ggml-model.bin"
ls -la "$DEST"
