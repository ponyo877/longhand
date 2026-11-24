# Fine-tuning Whisper (experimental)

These scripts fine-tune the decoder of Whisper large-v3-turbo with LoRA so that it writes product names and technical terms in their Latin spelling without dictionary hints.

**Status: not adopted.** Two training runs improved raw recognition of technical terms on synthetic speech by about 60%, but the gain disappeared after LLM formatting, and dictionary hints became less effective on real recordings.
The default model is unchanged. The scripts are kept for anyone who wants to continue the experiment.

Data and models are stored outside the repository, under `~/longhand-eval/`.

## Pipeline

```sh
# 1. Generate training sentences from the term lexicon. Terms used by the evaluation script are held out.
npx tsx finetune/gen-sentences.ts

# 2. Read them aloud with macOS voices, varying voice, speed, noise and volume.
npx tsx finetune/synth.ts

# 3. Trim silence exactly as the app does, cache encoder outputs, and build labels with timestamps.
#    Real speech and term-free sentences are labelled with the base model's own output (self-distillation).
cd finetune && ~/longhand-eval/exp/venv/bin/python prepare.py

# 4. Train (about 65 minutes for 1,400 steps on an M5 Mac, around 7 GB of memory).
~/longhand-eval/exp/venv/bin/python train.py --out run1

# 4'. Optionally interpolate between the base and fine-tuned weights without retraining.
~/longhand-eval/exp/venv/bin/python merge.py --run run1 --scale 0.5 --out run1-s050

# 5. Convert to the whisper.cpp format with 8-bit quantization.
cd .. && finetune/export.sh run1

# 6. Evaluate under the same conditions as the base model, then compare.
finetune/eval.sh base
finetune/eval.sh run1
npx tsx scripts/compare.ts ft-base-real ft-run1-real --stage asr
python3 finetune/report.py base run1

# 7. Evaluate with LLM formatting as well. Gains on raw recognition can vanish here.
LONGHAND_EVAL='{"name":"ft-run1-llm","datasets":["synth-script-v1"],"llm":"live","maxLlmCalls":150,
  "settings":{"asr":{"modelPath":"<home>/longhand-eval/models/whisper/ggml-turbo-ft-run1-q8_0.bin"}}}' npm start
```

## Design notes

- **The encoder is frozen.** Only the decoder learns which word to write for a sound, so training on synthetic speech does not degrade how real voices are heard.
- **Training data mirrors how the app calls the model.** Audio is trimmed with the same VAD settings, labels use timestamp tokens, and some samples carry a dictionary-style prompt. A first run without trimming learned to skip the beginning of long utterances.
- **Counterexamples matter.** Sentences with ordinary loanwords that should stay in katakana, term-free sentences and real speech keep the model from Latinizing everything.
- **Concatenated utterances** teach the model not to stop after the first sentence.
- **Weight interpolation** (`merge.py --scale`) trades term accuracy against regressions on ordinary speech.

## What was learned

- Raw recognition of technical terms improved even for held-out terms, and public read speech did not get worse.
- After LLM formatting there was no gain: the formatter already restores Latin spellings from katakana.
- The fine-tuned model sometimes wrote an unclear sound as a wrong Latin word. Katakana preserves the sound, so the formatter can still repair it. A wrong Latin word cannot be repaired.
- Training text was written language, and the model drifted toward it, adding particles that were not spoken.
- Progress would need real recordings of people saying technical terms and of casual speech.

## Requirements

- A Python virtual environment at `~/longhand-eval/exp/venv` with `torch`, `transformers` and `openai-whisper`
- `whisper-quantize` and `whisper-vad-speech-segments` built from the whisper.cpp examples into `~/longhand-eval/exp/wcpp-build/bin/`
- `openai/whisper-large-v3-turbo` from Hugging Face in `~/longhand-eval/exp/models/whisper-large-v3-turbo`
- FLEURS Japanese (train split) in `~/longhand-eval/public/fleurs-ja/`
- About 27 GB of disk space for cached encoder outputs (7,000 utterances)
