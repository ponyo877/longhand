#!/usr/bin/env bash
# ASR ワーカーをまとめてビルドし、asr/build/ に置いて署名する。
#
#   asr/build.sh              longhand-asr-whisper（既定のエンジン）と longhand-asr-apple（次点）
#   asr/build.sh --all        上に加えて longhand-asr-parakeet（FluidAudio）
#   asr/build.sh whisper      個別に指定することもできる（whisper / apple / parakeet / whisper-coreml）
#
# 署名: キーチェーンに "Apple Development" の証明書があればそれで、なければ ad-hoc で署名する。
#       CODESIGN_IDENTITY を設定すると、その ID を使う（配布用の "Developer ID Application: ..." など）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/build"
mkdir -p "$OUT"

targets=()
if [ $# -eq 0 ]; then
  targets=(whisper apple)
elif [ "$1" = "--all" ]; then
  targets=(whisper apple parakeet)
else
  targets=("$@")
fi

built=()
for t in "${targets[@]}"; do
  case "$t" in
    whisper)        "$HERE/whisper/build.sh";          built+=("$OUT/longhand-asr-whisper") ;;
    whisper-coreml) "$HERE/whisper/build.sh" --coreml; built+=("$OUT/longhand-asr-whisper" "$OUT/longhand-asr-whisper-coreml") ;;
    apple)          "$HERE/apple/build.sh";            built+=("$OUT/longhand-asr-apple") ;;
    parakeet)       "$HERE/parakeet/build.sh";         built+=("$OUT/longhand-asr-parakeet") ;;
    *) echo "unknown target: $t" >&2; exit 2 ;;
  esac
done

identity="${CODESIGN_IDENTITY:-}"
if [ -z "$identity" ]; then
  identity="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Apple Development/ {print $2; exit}')"
fi
if [ -z "$identity" ]; then
  identity="-"
  echo "署名: Apple Development の証明書がないので ad-hoc で署名する"
else
  echo "署名: $identity"
fi

for bin in "${built[@]}"; do
  # --options runtime: Hardened Runtime（公証に必要）。ワーカーは JIT もライブラリの差し込みも使わないので、追加の entitlements は不要
  codesign --force --sign "$identity" --options runtime --timestamp=none "$bin"
  codesign --verify --strict "$bin"
  echo "signed: $bin"
done
