#!/usr/bin/env bash
# Builds longhand-asr-parakeet in release mode and puts it in asr/build/.
# asr/build.sh does all the signing (not done here).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${HERE}/../build"
mkdir -p "${OUT}"

cd "${HERE}"
# --disable-keychain: when downloading the binary targets FluidAudio refers to (fetched even when left out by traits),
# keeps SwiftPM from looking for keychain credentials and stalling on a GUI permission prompt.
swift build -c release --disable-keychain --product longhand-asr-parakeet

BIN="$(swift build -c release --disable-keychain --show-bin-path)/longhand-asr-parakeet"
cp -f "${BIN}" "${OUT}/longhand-asr-parakeet"
echo "built: ${OUT}/longhand-asr-parakeet"
