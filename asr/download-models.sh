#!/usr/bin/env bash
# Downloads the ASR models to ~/Library/Application Support/Longhand/models/ and checks their SHA-256.
#
#   asr/download-models.sh              default: whisper large-v3-turbo q8_0 and Silero VAD (for longhand-asr-whisper, about 835 MB)
#   asr/download-models.sh --f16        also downloads whisper large-v3-turbo f16 (about 1.5 GB; an option when memory allows)
#   asr/download-models.sh --parakeet   also downloads the Core ML model of Parakeet TDT 0.6B Japanese (for longhand-asr-parakeet, about 620 MB)
#
# Files come from Hugging Face URLs pinned to a revision. Files already downloaded with a matching hash are not downloaded again.
# To use a mirror, set LONGHAND_HF_BASE (default https://huggingface.co).
# The OS downloads the models for Apple's SpeechTranscriber (longhand-asr-apple) from Apple's servers, so they are not handled here.
#
# After downloading and checking, writes models/<engine>/default.json for each engine (<engine> is the name in asr/build/longhand-asr-<engine>).
# When asr.modelPath in the settings is empty, the app loads with this modelPath (relative to this directory if relative) and options.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELS="${LONGHAND_MODELS_DIR:-$HOME/Library/Application Support/Longhand/models}"
HF="${LONGHAND_HF_BASE:-https://huggingface.co}"

WHISPER_REPO="ggerganov/whisper.cpp"
WHISPER_REV="5359861c739e955e79d9a303bcbc70fb988958b1"
VAD_REPO="ggml-org/whisper-vad"
VAD_REV="9ffd54a1e1ee413ddf265af9913beaf518d1639b"

want_f16=0
want_parakeet=0
for a in "$@"; do
  case "$a" in
    --f16) want_f16=1 ;;
    --parakeet) want_parakeet=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# write_default <engine> <modelPath (relative to the engine's directory)> <description>
# options is empty (the worker's defaults are the settings chosen by benchmark, docs/evaluation.md)
write_default() {
  local dir="$MODELS/$1"
  mkdir -p "$dir"
  printf '{\n  "modelPath": "%s",\n  "options": {},\n  "description": "%s"\n}\n' "$2" "$3" > "$dir/default.json.part"
  mv -f "$dir/default.json.part" "$dir/default.json"
  echo "wrote: $dir/default.json"
}

# fetch <url> <dest> <sha256>
fetch() {
  local url="$1" dest="$2" sha="$3"
  if [ -f "$dest" ] && [ "$(sha_of "$dest")" = "$sha" ]; then
    echo "ok (already downloaded): $dest"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  echo "downloading: $url"
  curl -fL --retry 3 --progress-bar -o "$dest.part" "$url"
  local got
  got="$(sha_of "$dest.part")"
  if [ "$got" != "$sha" ]; then
    rm -f "$dest.part"
    echo "SHA-256 mismatch: $dest (expected $sha, got $got)" >&2
    exit 1
  fi
  mv -f "$dest.part" "$dest"
  echo "ok: $dest"
}

# --- whisper (the default engine) ---
W="$MODELS/whisper"
fetch "$HF/$WHISPER_REPO/resolve/$WHISPER_REV/ggml-large-v3-turbo-q8_0.bin" "$W/ggml-large-v3-turbo-q8_0.bin" \
  317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1
fetch "$HF/$VAD_REPO/resolve/$VAD_REV/ggml-silero-v6.2.0.bin" "$W/ggml-silero-v6.2.0.bin" \
  2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987
if [ "$want_f16" = 1 ]; then
  fetch "$HF/$WHISPER_REPO/resolve/$WHISPER_REV/ggml-large-v3-turbo.bin" "$W/ggml-large-v3-turbo.bin" \
    1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69
fi
# The worker finds the VAD model in the same directory as the model (options.vadModelPath can change it)
write_default whisper "ggml-large-v3-turbo-q8_0.bin" "whisper large-v3-turbo q8_0 (Metal) + Silero VAD v6.2.0"

# --- Parakeet (optional) ---
if [ "$want_parakeet" = 1 ]; then
  list="$HERE/parakeet/model-files.txt"
  repo="FluidInference/parakeet-0.6b-ja-coreml"
  rev="$(awk '/^# FluidInference/ {print $4; exit}' "$list")"
  while read -r sha size path; do
    case "$sha" in ''|'#'*) continue ;; esac
    fetch "$HF/$repo/resolve/$rev/$path" "$MODELS/parakeet-ja/$path" "$sha"
  done < "$list"
  write_default parakeet "../parakeet-ja" "Parakeet TDT-CTC 0.6B ja (Core ML, FluidAudio)"
fi

echo "done: $MODELS"
