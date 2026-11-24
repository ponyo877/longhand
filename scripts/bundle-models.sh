#!/usr/bin/env bash
# 音声認識のモデルを resources/models/ に用意し、アプリに同梱できるようにする。
#
#   npm run bundle:models      既定のモデル（whisper large-v3-turbo q8_0 と Silero VAD、約 835 MB）
#
# この後の npm run package / npm run make が、resources/models をアプリの Resources/models に入れる。
# 同梱したアプリは、起動した PC が外へ出られなくても、そのまま音声認識を使える。
# すでに取得済みのモデル（~/Library/Application Support/Longhand/models）があれば、ハッシュを確かめて写す。
# なければ asr/download-models.sh で取得する（取得元は LONGHAND_HF_BASE でミラーに変えられる）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/resources/models"
SRC="${LONGHAND_MODELS_DIR_SRC:-$HOME/Library/Application Support/Longhand/models}"

sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# ファイル名と SHA-256（asr/download-models.sh、src/main/asr/ModelDownloader.ts と同じもの）
FILES=(
  "whisper/ggml-large-v3-turbo-q8_0.bin 317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1"
  "whisper/ggml-silero-v6.2.0.bin 2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987"
)

mkdir -p "$DEST/whisper"
need_download=0
for entry in "${FILES[@]}"; do
  rel="${entry%% *}"; sha="${entry##* }"
  if [ -f "$DEST/$rel" ] && [ "$(sha_of "$DEST/$rel")" = "$sha" ]; then
    echo "ok (用意済み): $rel"
  elif [ -f "$SRC/$rel" ] && [ "$(sha_of "$SRC/$rel")" = "$sha" ]; then
    cp "$SRC/$rel" "$DEST/$rel"
    echo "写した: $rel"
  else
    need_download=1
  fi
done

if [ "$need_download" = 1 ]; then
  echo "手元にないファイルを取得する"
  LONGHAND_MODELS_DIR="$DEST" bash "$ROOT/asr/download-models.sh"
fi

# アプリは default.json がなくても既定のファイル名で見つけるが、説明を出すために書いておく
printf '{\n  "modelPath": "ggml-large-v3-turbo-q8_0.bin",\n  "options": {},\n  "description": "whisper large-v3-turbo q8_0 (Metal) + Silero VAD v6.2.0"\n}\n' > "$DEST/whisper/default.json"

cat > "$DEST/NOTICE.txt" <<'TXT'
このフォルダのモデルは、次の公開物をそのまま同梱したものである。

- ggml-large-v3-turbo-q8_0.bin
  OpenAI Whisper large-v3-turbo を whisper.cpp の形式に変換し、量子化したもの。
  取得元: https://huggingface.co/ggerganov/whisper.cpp
  Whisper のモデルと whisper.cpp は MIT ライセンスで公開されている。
- ggml-silero-v6.2.0.bin
  Silero VAD を whisper.cpp の形式に変換したもの。
  取得元: https://huggingface.co/ggml-org/whisper-vad
  Silero VAD は MIT ライセンスで公開されている。
TXT

du -sh "${DEST}"
echo "完了: ${DEST}"
echo "この後の npm run package か npm run make で、アプリに同梱される。"
