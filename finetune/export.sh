#!/usr/bin/env bash
# 微調整したモデル（<置き場所>/<実行>/merged）を、whisper.cpp の形式（ggml、8 bit の量子化）に変える。
#
#   finetune/export.sh run1          → ~/longhand-eval/models/whisper/ggml-turbo-ft-run1-q8_0.bin
#
# 前提:
# - ~/longhand-eval/exp/venv に、torch、transformers、openai-whisper が入っている
# - ~/longhand-eval/exp/wcpp-build/bin/whisper-quantize がある
#   （cmake -S asr/whisper/third_party/whisper.cpp -B ~/longhand-eval/exp/wcpp-build -DWHISPER_BUILD_EXAMPLES=ON && cmake --build … --target whisper-quantize）
# 元のモデルを同じ手順で変えたものは、公式の ggml と同じ書き起こしになることを確かめてある（docs/evaluation.md）。
set -euo pipefail
RUN="${1:?実行の名前を指定してください}"
ROOT="${LONGHAND_FT_ROOT:-$HOME/longhand-eval/ft}"
EXP="$HOME/longhand-eval/exp"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$HOME/longhand-eval/models/whisper"
PY="$EXP/venv/bin/python"
WHISPER_PKG="$("$PY" -c "import whisper,os;print(os.path.dirname(os.path.dirname(whisper.__file__)))")"
TMP="$ROOT/$RUN/ggml"
mkdir -p "$TMP" "$OUT"
DEST="$OUT/ggml-turbo-ft-$RUN-q8_0.bin"
# 前の変換の結果を先に消す。途中で失敗したときに、古いモデルが残って、それを測ってしまうのを防ぐ
rm -f "$TMP/ggml-model.bin" "$DEST"
LOG="$TMP/export.log"
if ! "$PY" "$REPO/asr/whisper/third_party/whisper.cpp/models/convert-h5-to-ggml.py" "$ROOT/$RUN/merged" "$WHISPER_PKG" "$TMP" >"$LOG" 2>&1 || [ ! -s "$TMP/ggml-model.bin" ]; then
  tail -n 20 "$LOG" >&2
  echo "ggml への変換に失敗しました（記録: $LOG）" >&2
  exit 1
fi
if ! "$EXP/wcpp-build/bin/whisper-quantize" "$TMP/ggml-model.bin" "$DEST" q8_0 >>"$LOG" 2>&1 || [ ! -s "$DEST" ]; then
  tail -n 20 "$LOG" >&2
  rm -f "$DEST"
  echo "量子化に失敗しました（記録: $LOG）" >&2
  exit 1
fi
grep -E "quantize time" "$LOG" || true
rm -f "$TMP/ggml-model.bin"
ls -la "$DEST"
