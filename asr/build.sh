#!/usr/bin/env bash
# Builds all the ASR workers, puts them in asr/build/ and signs them.
#
#   asr/build.sh              longhand-asr-whisper (the default engine) and longhand-asr-apple (the runner-up)
#   asr/build.sh --all        the above plus longhand-asr-parakeet (FluidAudio)
#   asr/build.sh whisper      targets can also be named one by one (whisper / apple / parakeet / whisper-coreml)
#
# Signing: with the "Apple Development" certificate if the keychain has one, otherwise ad-hoc.
#       Set LONGHAND_SIGN_IDENTITY (same as helper/build.sh; "-" for ad-hoc) or CODESIGN_IDENTITY to use another identity.
#       Packaging re-signs the workers with the app's identity and a secure timestamp, so release builds need nothing here.
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

identity="${LONGHAND_SIGN_IDENTITY:-${CODESIGN_IDENTITY:-}}"
if [ -z "$identity" ]; then
  identity="$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Apple Development/ {print $2; exit}')"
fi
if [ -z "$identity" ]; then
  identity="-"
  echo "signing: no Apple Development certificate, signing ad-hoc"
else
  echo "signing: $identity"
fi

for bin in "${built[@]}"; do
  # --options runtime: Hardened Runtime (required for notarization). The workers use neither JIT nor library injection, so no extra entitlements are needed
  codesign --force --sign "$identity" --options runtime --timestamp=none "$bin"
  codesign --verify --strict "$bin"
  echo "signed: $bin"
done
