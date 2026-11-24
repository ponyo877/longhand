#!/usr/bin/env bash
# LonghandHelper をビルドして helper/build/LonghandHelper.app を作り、署名する。
#
#   ./build.sh                 リリースビルド + .app 組み立て + 署名
#   LONGHAND_SIGN_IDENTITY=<SHA-1>  署名に使う証明書を指定する（"-" で ad-hoc）
#
# 署名は「Apple Development」証明書を SHA-1 で選んで行う（見つからなければ ad-hoc）。
# 同じ証明書で署名し続ければ、アクセシビリティやマイクの許可がビルドをまたいで残る。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

VERSION="$(tr -d '[:space:]' < VERSION)"
BUILD_NUMBER="$(date +%Y%m%d%H%M)"
APP="$HERE/build/LonghandHelper.app"

echo "==> swift build -c release (arm64)"
swift build -c release --arch arm64
BIN_DIR="$(swift build -c release --arch arm64 --show-bin-path)"

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/LonghandHelper" "$APP/Contents/MacOS/LonghandHelper"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD_NUMBER/" Resources/Info.plist > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null
printf 'APPL????' > "$APP/Contents/PkgInfo"

IDENTITY="${LONGHAND_SIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  # "Apple Development: ..." の SHA-1 を取る（複数あれば最初のもの）
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk '/"Apple Development/ {print $2; exit}')"
fi
if [[ -z "$IDENTITY" ]]; then
  echo "warning: Apple Development identity not found; signing ad-hoc (TCC grants will not survive rebuilds)" >&2
  IDENTITY="-"
fi

echo "==> codesign (identity: $IDENTITY, hardened runtime)"
codesign --force --sign "$IDENTITY" --options runtime --timestamp=none \
  --entitlements Resources/LonghandHelper.entitlements "$APP"
codesign --verify --strict --verbose=1 "$APP"
codesign -d -r- "$APP" 2>/dev/null | sed -n 's/^designated => /designated requirement: /p'

echo "==> done: $APP ($VERSION build $BUILD_NUMBER)"
