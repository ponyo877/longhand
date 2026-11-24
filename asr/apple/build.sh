#!/usr/bin/env bash
# Builds longhand-asr-apple in release mode and puts it at asr/build/longhand-asr-apple.
# Requires Xcode 26 or later (macOS 26 SDK) and an Apple Silicon Mac.
# asr/build.sh does all the signing (a binary built by this script alone also runs as is).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "${OUT_DIR:-$HERE/../build}"
OUT_DIR="$(cd "${OUT_DIR:-$HERE/../build}" && pwd)"

cd "$HERE"
swift build -c release --arch arm64
BIN_DIR="$(swift build -c release --arch arm64 --show-bin-path)"

cp -f "$BIN_DIR/longhand-asr-apple" "$OUT_DIR/longhand-asr-apple"
echo "built: $OUT_DIR/longhand-asr-apple"
