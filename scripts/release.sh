#!/usr/bin/env bash
# Builds a signed and notarized release of Longhand into out/release/:
#   Longhand-<version>-arm64.dmg, Longhand-darwin-arm64-<version>.zip and SHA256SUMS.txt
#
# Requirements (see docs/releasing.md):
#   - A "Developer ID Application" certificate in the keychain
#   - Notarization credentials in the environment, one of:
#       APPLE_KEYCHAIN_PROFILE                              profile saved with `xcrun notarytool store-credentials`
#       APPLE_API_KEY (path to .p8), APPLE_API_KEY_ID, APPLE_API_ISSUER   App Store Connect API key
#       APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID              Apple ID with an app-specific password
#
# Options:
#   --skip-native   Reuse helper/build and asr/build instead of rebuilding them
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

skip_native=0
for arg in "$@"; do
  case "$arg" in
    --skip-native) skip_native=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "release builds must run on macOS"
[ "$(uname -m)" = arm64 ] || die "release builds must run on Apple Silicon"

# --- Signing certificate ----------------------------------------------------------
identity="$(security find-identity -v -p codesigning | awk '/"Developer ID Application/ {print $2; exit}')"
[ -n "$identity" ] || die 'no "Developer ID Application" certificate in the keychain'
# The certificate name contains a person's name, so only the first characters of the hash are printed
echo "==> signing with Developer ID Application (${identity:0:8}…)"

# --- Notarization credentials -----------------------------------------------------
notary_args=()
if [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  notary_args=(--keychain-profile "$APPLE_KEYCHAIN_PROFILE")
elif [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ]; then
  [ -f "$APPLE_API_KEY" ] || die "APPLE_API_KEY must be the path to the .p8 key file"
  notary_args=(--key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID")
  [ -n "${APPLE_API_ISSUER:-}" ] && notary_args+=(--issuer "$APPLE_API_ISSUER")
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  notary_args=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
else
  die "no notarization credentials in the environment (see docs/releasing.md)"
fi

version="$(node -p "require('./package.json').version")"
echo "==> Longhand $version"

# --- Build --------------------------------------------------------------------------
export LONGHAND_RELEASE=1
export LONGHAND_SIGN_IDENTITY="$identity"
if [ "$skip_native" = 0 ]; then
  npm run build:native
fi
[ -d helper/build/LonghandHelper.app ] || die "helper/build/LonghandHelper.app is missing (run without --skip-native)"
[ -x asr/build/longhand-asr-whisper ] || die "asr/build/longhand-asr-whisper is missing (run without --skip-native)"

rm -rf out/make out/release
# Signs every executable with the Developer ID certificate, notarizes the app and staples the ticket (forge.config.mts),
# then makes the .dmg and .zip from the stapled app
npm run make

app="out/Longhand-darwin-arm64/Longhand.app"
dmg="$(find out/make -name '*.dmg' -print -quit)"
zip="$(find out/make -name '*.zip' -print -quit)"
[ -d "$app" ] || die "$app was not built"
[ -n "$dmg" ] || die "no .dmg in out/make"
[ -n "$zip" ] || die "no .zip in out/make"

# --- Disk image ---------------------------------------------------------------------
# The app inside is already notarized. Signing and notarizing the image as well lets Gatekeeper check it before it is opened
echo "==> signing and notarizing $(basename "$dmg")"
codesign --force --sign "$identity" --timestamp "$dmg"
xcrun notarytool submit "$dmg" "${notary_args[@]}" --wait
xcrun stapler staple "$dmg"

# --- Verification -------------------------------------------------------------------
echo "==> verifying"
codesign --verify --deep --strict "$app"
xcrun stapler validate "$app"
spctl --assess --type execute "$app"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature "$dmg"
# Every nested executable must carry the hardened runtime and a secure timestamp, or notarization of later builds can fail
while IFS= read -r -d '' bin; do
  info="$(codesign -dv "$bin" 2>&1)"
  grep -q 'flags=.*runtime' <<<"$info" || die "missing hardened runtime: $bin"
  grep -q '^Timestamp=' <<<"$info" || die "missing secure timestamp: $bin"
done < <(find "$app/Contents/Resources" -type f -perm -u+x -print0)

# --- Output -------------------------------------------------------------------------
mkdir -p out/release
cp "$dmg" "$zip" out/release/
(cd out/release && shasum -a 256 -- *.dmg *.zip > SHA256SUMS.txt)
echo "==> done"
ls -l out/release
