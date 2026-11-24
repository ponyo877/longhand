#!/usr/bin/env bash
# Fetches whisper.cpp at a pinned tag into third_party/ (not committed; already in .gitignore).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WHISPER_TAG="v1.9.5"
WHISPER_COMMIT="d1be6fde11ac6e0407606b4e42fe72d34add8037"
DEST="$HERE/third_party/whisper.cpp"

if [ -d "$DEST/.git" ]; then
  cur="$(git -C "$DEST" rev-parse HEAD)"
  if [ "$cur" = "$WHISPER_COMMIT" ]; then
    echo "whisper.cpp $WHISPER_TAG ($WHISPER_COMMIT) already fetched"
    exit 0
  fi
  echo "whisper.cpp is at a different commit, fetching again: $cur" >&2
  rm -rf "$DEST"
fi
mkdir -p "$HERE/third_party"
git clone --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp.git "$DEST"
got="$(git -C "$DEST" rev-parse HEAD)"
if [ "$got" != "$WHISPER_COMMIT" ]; then
  echo "whisper.cpp $WHISPER_TAG is at an unexpected commit: $got (expected $WHISPER_COMMIT)" >&2
  exit 1
fi
echo "fetched whisper.cpp $WHISPER_TAG ($got)"
