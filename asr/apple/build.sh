#!/usr/bin/env bash
# longhand-asr-apple をリリースビルドし、asr/build/longhand-asr-apple に置く。
# 必要なもの: Xcode 26 以降（macOS 26 SDK）、Apple Silicon の Mac。
# 署名は asr/build.sh がまとめて行う（このスクリプト単体で作ったバイナリも、そのまま実行できる）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "${OUT_DIR:-$HERE/../build}"
OUT_DIR="$(cd "${OUT_DIR:-$HERE/../build}" && pwd)"

cd "$HERE"
swift build -c release --arch arm64
BIN_DIR="$(swift build -c release --arch arm64 --show-bin-path)"

cp -f "$BIN_DIR/longhand-asr-apple" "$OUT_DIR/longhand-asr-apple"
echo "built: $OUT_DIR/longhand-asr-apple"
