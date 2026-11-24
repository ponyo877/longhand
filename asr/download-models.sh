#!/usr/bin/env bash
# ASR のモデルを ~/Library/Application Support/Longhand/models/ に取得し、SHA-256 を確かめる。
#
#   asr/download-models.sh              既定: whisper large-v3-turbo q8_0 と Silero VAD（longhand-asr-whisper 用、約 835 MB）
#   asr/download-models.sh --f16        whisper large-v3-turbo f16 も取得する（約 1.5 GB。メモリに余裕がある場合の選択肢）
#   asr/download-models.sh --parakeet   Parakeet TDT 0.6B 日本語版の Core ML モデルも取得する（longhand-asr-parakeet 用、約 620 MB）
#
# 取得元は Hugging Face のリビジョンを固定した URL。取得済みでハッシュが合うファイルは取り直さない。
# ミラーを使う場合は LONGHAND_HF_BASE を設定する（既定 https://huggingface.co）。
# Apple の SpeechTranscriber（longhand-asr-apple）のモデルは OS が Apple のサーバーから取得するので、ここでは扱わない。
#
# 取得と検証のあと、エンジンごとに models/<engine>/default.json を書く（<engine> は asr/build/longhand-asr-<engine> の名前）。
# アプリは設定の asr.modelPath が空のとき、この modelPath（相対ならこのディレクトリから）と options で load する。
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

# write_default <engine> <modelPath（engine のディレクトリからの相対）> <description>
# options は空（ワーカーの既定がベンチマークで選んだ設定。docs/evaluation.md）
write_default() {
  local dir="$MODELS/$1"
  mkdir -p "$dir"
  printf '{\n  "modelPath": "%s",\n  "options": {},\n  "description": "%s"\n}\n' "$2" "$3" > "$dir/default.json.part"
  mv -f "$dir/default.json.part" "$dir/default.json"
  echo "書き込み: $dir/default.json"
}

# fetch <url> <dest> <sha256>
fetch() {
  local url="$1" dest="$2" sha="$3"
  if [ -f "$dest" ] && [ "$(sha_of "$dest")" = "$sha" ]; then
    echo "ok (取得済み): $dest"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  echo "取得: $url"
  curl -fL --retry 3 --progress-bar -o "$dest.part" "$url"
  local got
  got="$(sha_of "$dest.part")"
  if [ "$got" != "$sha" ]; then
    rm -f "$dest.part"
    echo "SHA-256 が一致しない: $dest（期待 $sha、実際 $got）" >&2
    exit 1
  fi
  mv -f "$dest.part" "$dest"
  echo "ok: $dest"
}

# --- whisper（既定のエンジン） ---
W="$MODELS/whisper"
fetch "$HF/$WHISPER_REPO/resolve/$WHISPER_REV/ggml-large-v3-turbo-q8_0.bin" "$W/ggml-large-v3-turbo-q8_0.bin" \
  317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1
fetch "$HF/$VAD_REPO/resolve/$VAD_REV/ggml-silero-v6.2.0.bin" "$W/ggml-silero-v6.2.0.bin" \
  2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987
if [ "$want_f16" = 1 ]; then
  fetch "$HF/$WHISPER_REPO/resolve/$WHISPER_REV/ggml-large-v3-turbo.bin" "$W/ggml-large-v3-turbo.bin" \
    1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69
fi
# VAD のモデルは、ワーカーがモデルと同じディレクトリから自動で見つける（options.vadModelPath で変えられる）
write_default whisper "ggml-large-v3-turbo-q8_0.bin" "whisper large-v3-turbo q8_0 (Metal) + Silero VAD v6.2.0"

# --- Parakeet（任意） ---
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

echo "完了: $MODELS"
