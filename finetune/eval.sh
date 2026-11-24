#!/usr/bin/env bash
# 微調整したモデルを、元のモデルと同じ条件で測る（LLM なし。音声認識の生の出力と、LLM なしの最終を比べるため）。
#
#   finetune/eval.sh base         → 元のモデル（比べる相手）。実行の名前は ft-base-…
#   finetune/eval.sh run1         → ~/longhand-eval/models/whisper/ggml-turbo-ft-run1-q8_0.bin を測る。実行の名前は ft-run1-…
#   finetune/eval.sh run1 real synth   → 組を絞る
#
# 測る組は 4 つ。
#   real         利用者の録音と公開データ、辞書なし
#   synth        合成音声の台本と話し言葉、辞書なし
#   real-vocab   利用者の録音と公開データ、評価用の辞書 18 語（ヒントの効きが保たれているかを見る）
#   synth-vocab  合成音声の台本、台本の用語 91 語
# 比べ方:
#   npx tsx scripts/compare.ts ft-base-real ft-run1-real --stage asr
set -euo pipefail
RUN="${1:?実行の名前（base か、export.sh に渡した名前）を指定してください}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVAL="$HOME/longhand-eval"
cd "$REPO"
if [ "$RUN" = base ]; then
  SETTINGS='{}'
else
  MODEL="$EVAL/models/whisper/ggml-turbo-ft-$RUN-q8_0.bin"
  [ -f "$MODEL" ] || { echo "モデルがありません: $MODEL" >&2; exit 1; }
  SETTINGS="{\"asr\":{\"modelPath\":\"$MODEL\"}}"
fi
go() { # 名前、データセット、辞書（無ければ空）
  local extra=()
  [ -n "${3:-}" ] && extra=(--vocab "$3")
  npx tsx scripts/eval-run.ts --name "ft-$RUN-$1" --datasets "$2" --llm off --settings "$SETTINGS" ${extra[@]+"${extra[@]}"} 2>&1 \
    | grep -E "^評価 |^\[(全体|user|fleurs|synth)|書き起こしの生の出力|LLM なしの最終|^英字の語|^音声認識|失敗|見つかりません" | cut -c1-170 || true
}
shift
GROUPS_="${*:-real synth real-vocab synth-vocab}"
for g in $GROUPS_; do
  case "$g" in
    real) go real user-v1,user-v2,fleurs-ja-v1 ;;
    synth) go synth synth-script-v1,synth-spoken-v1 ;;
    real-vocab) go real-vocab user-v1,user-v2,fleurs-ja-v1 "$EVAL/hints.txt" ;;
    synth-vocab) go synth-vocab synth-script-v1 "$EVAL/synth-script-terms.txt" ;;
    *) echo "知らない組です: $g" >&2; exit 1 ;;
  esac
done
