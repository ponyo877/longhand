#!/usr/bin/env bash
# Builds longhand-asr-whisper (Metal version) and puts it in asr/build/.
#   ./build.sh            Metal version only
#   ./build.sh --coreml   also builds the Core ML encoder version (longhand-asr-whisper-coreml) (optional, for benchmarks)
# asr/build.sh does all the signing.
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
