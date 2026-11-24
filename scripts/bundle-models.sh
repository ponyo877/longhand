#!/usr/bin/env bash
# Prepares the speech recognition models in resources/models/ so that they can be bundled with the app.
#
#   npm run bundle:models      default models (whisper large-v3-turbo q8_0 and Silero VAD, about 835 MB)
#
# A later npm run package / npm run make puts resources/models into the app's Resources/models.
# An app with bundled models can use speech recognition right away, even on a machine that cannot reach the internet.
# If the models were already downloaded (~/Library/Application Support/Longhand/models), they are copied after checking their hashes.
# Otherwise asr/download-models.sh downloads them (LONGHAND_HF_BASE can point the source at a mirror).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/resources/models"
SRC="${LONGHAND_MODELS_DIR_SRC:-$HOME/Library/Application Support/Longhand/models}"

sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# File names and SHA-256 (the same as in asr/download-models.sh and src/main/asr/ModelDownloader.ts)
FILES=(
  "whisper/ggml-large-v3-turbo-q8_0.bin 317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1"
  "whisper/ggml-silero-v6.2.0.bin 2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987"
)

mkdir -p "$DEST/whisper"
need_download=0
for entry in "${FILES[@]}"; do
  rel="${entry%% *}"; sha="${entry##* }"
  if [ -f "$DEST/$rel" ] && [ "$(sha_of "$DEST/$rel")" = "$sha" ]; then
    echo "ok (already present): $rel"
  elif [ -f "$SRC/$rel" ] && [ "$(sha_of "$SRC/$rel")" = "$sha" ]; then
    cp "$SRC/$rel" "$DEST/$rel"
    echo "copied: $rel"
  else
    need_download=1
  fi
done

if [ "$need_download" = 1 ]; then
  echo "downloading missing files"
  LONGHAND_MODELS_DIR="$DEST" bash "$ROOT/asr/download-models.sh"
fi

# The app finds the default file name even without default.json, but write it so that a description can be shown
printf '{\n  "modelPath": "ggml-large-v3-turbo-q8_0.bin",\n  "options": {},\n  "description": "whisper large-v3-turbo q8_0 (Metal) + Silero VAD v6.2.0"\n}\n' > "$DEST/whisper/default.json"

cat > "$DEST/NOTICE.txt" <<'TXT'
The models in this folder are the following public releases, bundled unchanged.

- ggml-large-v3-turbo-q8_0.bin
  OpenAI Whisper large-v3-turbo, converted to the whisper.cpp format and quantized.
  Source: https://huggingface.co/ggerganov/whisper.cpp
  The Whisper model and whisper.cpp are released under the MIT License.
- ggml-silero-v6.2.0.bin
  Silero VAD, converted to the whisper.cpp format.
  Source: https://huggingface.co/ggml-org/whisper-vad
  Silero VAD is released under the MIT License.
TXT

du -sh "${DEST}"
echo "done: ${DEST}"
echo "A later npm run package or npm run make bundles them with the app."
