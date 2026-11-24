#!/usr/bin/env bash
# longhand-asr-parakeet をリリースビルドして asr/build/ に置く。
# 署名は asr/build.sh がまとめて行う（ここでは行わない）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${HERE}/../build"
mkdir -p "${OUT}"

cd "${HERE}"
# --disable-keychain: FluidAudio が参照するバイナリターゲット（traits で外していても取得はされる）の
# ダウンロード時に、SwiftPM がキーチェーンの認証情報を探して GUI の許可待ちで止まるのを避ける。
swift build -c release --disable-keychain --product longhand-asr-parakeet

BIN="$(swift build -c release --disable-keychain --show-bin-path)/longhand-asr-parakeet"
cp -f "${BIN}" "${OUT}/longhand-asr-parakeet"
echo "built: ${OUT}/longhand-asr-parakeet"
