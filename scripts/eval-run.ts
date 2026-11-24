/**
 * Runs an evaluation (without the LLM, or with saved LLM results only).
 *
 *   npx tsx scripts/eval-run.ts --name base --datasets user-v1,user-v2 --llm off
 *   npx tsx scripts/eval-run.ts --name base --datasets user-v1,user-v2 --llm cache-only
 *     --config <json>      config file (EvalConfig in src/main/eval/run.ts). Other arguments override it
 *     --name <name>        run name (goes into the result folder name)
 *     --datasets <a,b>     dataset names (under ~/longhand-eval/datasets/)
 *     --llm <off|cache-only>  off runs without the LLM. cache-only re-scores using only the results saved when measuring inside the app
 *     --vocab <file>       dictionary words (one per line; the list for evaluation is ~/longhand-eval/hints.txt). Without it, no dictionary
 *     --readings <file>    readings (one "word<TAB>reading,reading" per line), treated as confirmed readings
 *     --settings <json>    overrides of the app's default settings (JSON itself or a file), for example '{"llmFastPath":false}'
 *     --split <dev|holdout|all>  measure only the dev or holdout split
 *     --limit <n> / --ids <a,b>  narrow down the utterances
 *     --attempt <n>        LLM attempt number (part of the key of saved results)
 *     --asr cache-only     do not run speech recognition; use saved results only
 *     --recent <previous|none>  the "recent transcripts" used to score dictionary words
 *     --truncate-tail <postRoll|ms>  cut off the end of the audio before transcribing (experimental). postRoll cuts each row's
 *                          "length recorded after the key was released"; a number cuts that length (ms) from every row. Compares the
 *                          same recordings with and without the audio after release
 *
 * Evaluations that actually call the LLM run inside the development build of the app (they use the connection settings and key saved
 * in the app; the key is never read out):
 *   LONGHAND_EVAL='{"name":"base","datasets":["user-v1","user-v2"],"llm":"live"}' npm start
 *   (if the development build is already running and .vite/build is up to date, LONGHAND_EVAL=… npx electron . also works)
 *
 * Standard output gets numbers only. Per-utterance sentences are written only to ~/longhand-eval/runs/<run>/rows.jsonl.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { expandHome, parseEvalConfig, validateEvalConfig } from '../src/main/eval/config';
import { evalRoot } from '../src/main/eval/files';
import { runEval, type EvalConfig } from '../src/main/eval/run';

const { values: args } = parseArgs({
  options: {
    config: { type: 'string' },
    name: { type: 'string' },
    datasets: { type: 'string' },
    llm: { type: 'string' },
    vocab: { type: 'string' },
    readings: { type: 'string' },
    settings: { type: 'string' },
    split: { type: 'string' },
    limit: { type: 'string' },
    ids: { type: 'string' },
    attempt: { type: 'string' },
    asr: { type: 'string' },
    recent: { type: 'string' },
    'truncate-tail': { type: 'string' },
    models: { type: 'string', default: path.join(os.homedir(), 'Library', 'Application Support', 'Longhand', 'models') },
  },
});

function buildConfig(): EvalConfig {
  const base: Partial<EvalConfig> = args.config ? parseEvalConfig(args.config) : {};
  const list = (s: string) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  const settings = args.settings ? JSON.parse(args.settings.trim().startsWith('{') ? args.settings : fs.readFileSync(expandHome(args.settings), 'utf8')) : base.settings;
  return validateEvalConfig({
    ...base,
    name: args.name ?? base.name,
    datasets: args.datasets ? list(args.datasets) : base.datasets,
    llm: args.llm ?? base.llm ?? 'off',
    vocab: args.vocab ?? base.vocab,
    readings: args.readings ?? base.readings,
    settings,
    split: args.split ?? base.split,
    limit: args.limit ? Number(args.limit) : base.limit,
    ids: args.ids ? list(args.ids) : base.ids,
    attempt: args.attempt ? Number(args.attempt) : base.attempt,
    asrCacheOnly: args.asr ? args.asr === 'cache-only' : base.asrCacheOnly,
    recent: args.recent ?? base.recent,
    truncateTail: args['truncate-tail'] === undefined ? base.truncateTail : args['truncate-tail'] === 'postRoll' ? 'postRoll' : Number(args['truncate-tail']),
  });
}

async function main(): Promise<void> {
  const config = buildConfig();
  const repoRoot = process.cwd();
  const { summary } = await runEval(config, {
    root: evalRoot(),
    repoRoot,
    modelsDir: args.models!,
    bundledModelsDir: path.join(repoRoot, 'resources', 'models'),
    host: `tsx node ${process.versions.node}`,
  });
  if (summary.status !== 'ok') process.exitCode = 2;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
