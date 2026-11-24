# Evaluation

Accuracy work on a dictation app is only as good as its measurements.
Longhand ships an evaluation harness that runs recordings through the same functions the app uses, stage by stage, and compares two runs with a paired bootstrap.

## What is measured

Each utterance has a reference text (what should have been typed) and, optionally, alternative spellings that are equally correct (for example `あとで` and `後で`).
The harness reports the character error rate on content, ignoring punctuation and whitespace, at four stages:

| Stage | Output of |
|---|---|
| `asr` | The recognizer |
| `match` | Dictionary reading match |
| `noLlm` | Rule-based fixes. This is what is typed when formatting is off |
| `final` | LLM formatting |

It also reports recall of Latin-script terms, error categories (homophones, particles, insertions, deletions and so on), and how often formatting improved or damaged an utterance.

## Datasets

Evaluation data lives outside the repository, in `~/longhand-eval/` (override with `LONGHAND_EVAL_ROOT`).
Recordings of real people must never be committed.

| Dataset | How to create it | Reference quality |
|---|---|---|
| Public read speech | `npx tsx scripts/eval-import-public.ts` imports a fixed subset of FLEURS Japanese (CC BY 4.0) | Exact |
| Technical-term script | `npx tsx scripts/eval-synth.ts --script scripts/review/script-v1.json --name synth-script-v1` reads 60 sentences with three macOS voices each | Exact |
| Disfluent speech | Same, with `scripts/review/spoken-v1.json` (fillers, self-corrections, questions) | Exact |
| Notation preferences | Same, with `scripts/review/kept-v1.json` | Exact |
| Your own dictations | `npx tsx scripts/eval-import.ts` copies Longhand's history and recordings before they expire | Provisional until reviewed |

Synthetic speech is clearer than a human voice. It is used to compare conditions, not to estimate real-world accuracy.
`npx tsx scripts/review/server.ts` starts a local page for listening to recordings and correcting their references.

## Running

```sh
# Without an LLM
npx tsx scripts/eval-run.ts --name base --datasets fleurs-ja-v1,synth-script-v1 --llm off

# With the LLM configured in the app. Runs inside the development build so the saved key is used
# without being read by scripts. Results are cached, so identical runs make no new calls.
LONGHAND_EVAL='{"name":"base-llm","datasets":["synth-script-v1"],"split":"dev","llm":"live","maxLlmCalls":150}' npm start

# Compare two runs: difference in errors with a 95% interval
npx tsx scripts/compare.ts base base-llm --stage final
```

Settings can be overridden per run with `--settings '{"asr":{"hintMode":"always"}}'`, and learning from corrections can be simulated with a `learn` entry in the config.

## Adoption rule

A change becomes a default only if all of the following hold:

1. On the development split, the 95% interval of the error difference excludes zero.
2. The holdout split does not get worse.
3. Public data, false insertions of dictionary terms and the rate of damaged utterances do not get worse.

Changes that fail the rule stay off by default or are removed.

## Results

Character error rate, with the default settings (Whisper large-v3-turbo q8, Claude Opus 5.5 at low effort for formatting).

| Dataset | Utterances | `asr` | `final` |
|---|---|---|---|
| FLEURS Japanese | 135 | 4.20% | 2.59% |
| Technical-term script (synthetic) | 180 | 7.96% | 1.67% |
| Disfluent speech (synthetic) | 156 | 11.01% | 2.38% |

On FLEURS, formatting improved 43 utterances and made 3 worse.

Time per utterance on an Apple M5, for recordings of about five seconds:

| Step | Median |
|---|---|
| Recognition, one pass | 0.45 s |
| Recognition with a dictionary (two passes) | 1.0 s |
| Formatting (Claude Opus 5.5, low effort) | 1.3 s |

## What was tried

Adopted:

- Recording a 300 ms tail after key release. Sentence endings were being cut off.
- Restoring Latin spellings of technical terms and repairing particles without an LLM.
- Taking dictionary hints only where they produced a dictionary term. Always-on hints fixed terms but changed unrelated speech.
- Passing low-confidence spans to the formatter as evidence.
- Learning correction pairs and kept phrases in addition to new terms.
- Sending every utterance through the formatter. Skipping the LLM for clean-looking short utterances saved about 1.3 s on a fifth of utterances, but formatting removes about 30% of the errors in those utterances, mostly confident mishearings of homophones.

Measured and not adopted:

| Idea | Why not |
|---|---|
| Beam search, larger VAD padding, Whisper large-v3 | Slightly better on read speech, worse on spontaneous dictation |
| Other engines (Parakeet, SenseVoice, ReazonSpeech, kotoba-whisper, Apple) as the default | Less accurate than large-v3-turbo on the same recordings. Apple and Parakeet remain available as options |
| Re-listening at other temperatures and letting the LLM arbitrate disagreements | Helped the development split, did not reproduce on holdout |
| Picking up terms from the focused window automatically (simulated) | More Latin terms recognized, but no fewer errors overall |
| Guards that revert unsupported LLM edits | Made results worse: they reverted useful repairs |
| Fine-tuning the Whisper decoder (LoRA) on synthetic speech | Large gains on raw recognition of technical terms, none after formatting, and weaker dictionary hints. See `finetune/README.md` |
