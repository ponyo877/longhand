#!/usr/bin/env bash
# longhand-asr-whisper（Metal 版）をビルドし、asr/build/ に置く。
#   ./build.sh            Metal 版のみ
#   ./build.sh --coreml   Core ML エンコーダ版（longhand-asr-whisper-coreml）も作る（任意。ベンチマーク用）
# 署名は asr/build.sh がまとめて行う。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../build"
mkdir -p "$OUT"
JOBS="$(sysctl -n hw.ncpu)"

"$HERE/fetch-deps.sh"

cmake -S "$HERE" -B "$HERE/build/metal" -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 >/dev/null
cmake --build "$HERE/build/metal" --target longhand-asr-whisper -j "$JOBS"
cp -f "$HERE/build/metal/bin/longhand-asr-whisper" "$OUT/longhand-asr-whisper"
echo "built: $OUT/longhand-asr-whisper"

if [ "${1:-}" = "--coreml" ]; then
  cmake -S "$HERE" -B "$HERE/build/coreml" -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64 -DLONGHAND_WHISPER_COREML=ON >/dev/null
  cmake --build "$HERE/build/coreml" --target longhand-asr-whisper-coreml -j "$JOBS"
  cp -f "$HERE/build/coreml/bin/longhand-asr-whisper-coreml" "$OUT/longhand-asr-whisper-coreml"
  echo "built: $OUT/longhand-asr-whisper-coreml"
fi
