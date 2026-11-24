#!/usr/bin/env bash
# Builds LonghandHelper, assembles helper/build/LonghandHelper.app and signs it.
#
#   ./build.sh                 release build + .app assembly + signing
#   LONGHAND_SIGN_IDENTITY=<SHA-1>  certificate to sign with ("-" for ad-hoc)
#
# Signs with an "Apple Development" certificate picked by SHA-1 (ad-hoc if none is found).
# As long as every build is signed with the same certificate, the Accessibility and microphone permissions survive rebuilds.
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
# Localized usage descriptions (the permission prompts follow the macOS language)
for lproj in Resources/*.lproj; do
  mkdir -p "$APP/Contents/Resources/$(basename "$lproj")"
  cp "$lproj"/InfoPlist.strings "$APP/Contents/Resources/$(basename "$lproj")/"
done
printf 'APPL????' > "$APP/Contents/PkgInfo"

IDENTITY="${LONGHAND_SIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  # Take the SHA-1 of "Apple Development: ..." (the first one if there are several)
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
