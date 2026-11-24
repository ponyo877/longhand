#!/usr/bin/env bash
# Measures a fine-tuned model under the same conditions as the base model (without the LLM, to compare raw speech recognition output
# and the final output without the LLM).
#
#   finetune/eval.sh base         → the base model (the baseline). Run names are ft-base-…
#   finetune/eval.sh run1         → measures ~/longhand-eval/models/whisper/ggml-turbo-ft-run1-q8_0.bin. Run names are ft-run1-…
#   finetune/eval.sh run1 real synth   → limit to the given groups
#
# There are four groups.
#   real         the user's recordings and public data, no dictionary
#   synth        the synthesized script and spoken-style sentences, no dictionary
#   real-vocab   the user's recordings and public data, the 18-word evaluation dictionary (checks that hints still work)
#   synth-vocab  the synthesized script, the script's 91 terms
# To compare:
#   npx tsx scripts/compare.ts ft-base-real ft-run1-real --stage asr
set -euo pipefail
RUN="${1:?give a run name (base, or the name passed to export.sh)}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVAL="$HOME/longhand-eval"
cd "$REPO"
if [ "$RUN" = base ]; then
  SETTINGS='{}'
else
  MODEL="$EVAL/models/whisper/ggml-turbo-ft-$RUN-q8_0.bin"
  [ -f "$MODEL" ] || { echo "Model not found: $MODEL" >&2; exit 1; }
  SETTINGS="{\"asr\":{\"modelPath\":\"$MODEL\"}}"
fi
go() { # name, datasets, dictionary (empty for none)
  local extra=()
  [ -n "${3:-}" ] && extra=(--vocab "$3")
  npx tsx scripts/eval-run.ts --name "ft-$RUN-$1" --datasets "$2" --llm off --settings "$SETTINGS" ${extra[@]+"${extra[@]}"} 2>&1 \
    | grep -E "^Eval |^\[(All|user|fleurs|synth)|raw transcription|final without LLM|^Latin words|^Speech recognition|failed|not found" | cut -c1-170 || true
}
shift
GROUPS_="${*:-real synth real-vocab synth-vocab}"
for g in $GROUPS_; do
  case "$g" in
    real) go real user-v1,user-v2,fleurs-ja-v1 ;;
    synth) go synth synth-script-v1,synth-spoken-v1 ;;
    real-vocab) go real-vocab user-v1,user-v2,fleurs-ja-v1 "$EVAL/hints.txt" ;;
    synth-vocab) go synth-vocab synth-script-v1 "$EVAL/synth-script-terms.txt" ;;
    *) echo "Unknown group: $g" >&2; exit 1 ;;
  esac
done
