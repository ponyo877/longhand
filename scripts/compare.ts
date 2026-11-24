/**
 * Compares two evaluation runs. A paired bootstrap over utterances gives the difference in error count and its 95% interval.
 *
 *   npx tsx scripts/compare.ts <run A> <run B> [--stage final] [--metric content]
 *     A run is a folder name under ~/longhand-eval/runs/ or a folder path. Given only a run name, the newest run with that name is used
 *     --stage <asr|match|noLlm|final>  stage to compare (default final; noLlm when comparing runs without the LLM)
 *     --metric <content|full>          content only, or including punctuation (default content)
 *     --iterations <n>                 number of resamples (default 10000)
 *     --seed <n>                       random seed (default 1)
 *
 * The difference is B − A. Negative means B has fewer errors. Prints numbers only.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { compareRuns, formatComparison, type CompareMetric } from '../src/main/eval/compare';
import { resolveRunDir } from '../src/main/eval/config';
import { evalRoot, readJsonl } from '../src/main/eval/files';
import { STAGES, type RowRecord, type StageName } from '../src/main/eval/score';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    stage: { type: 'string', default: 'final' },
    metric: { type: 'string', default: 'content' },
    iterations: { type: 'string', default: '10000' },
    seed: { type: 'string', default: '1' },
  },
});

const resolveRun = (spec: string) => resolveRunDir(spec, path.join(evalRoot(), 'runs'));

function main(): void {
  if (positionals.length !== 2) throw new Error('Usage: npx tsx scripts/compare.ts <run A> <run B> [--stage final] [--metric content]');
  const stage = args.stage as StageName;
  const metric = args.metric as CompareMetric;
  if (!STAGES.includes(stage)) throw new Error(`--stage must be one of ${STAGES.join(', ')}`);
  if (metric !== 'content' && metric !== 'full') throw new Error('--metric must be content or full');
  const [dirA, dirB] = positionals.map(resolveRun);
  const a = readJsonl<RowRecord>(path.join(dirA, 'rows.jsonl'));
  const b = readJsonl<RowRecord>(path.join(dirB, 'rows.jsonl'));
  const r = compareRuns(a, b, { stage, metric, iterations: Number(args.iterations), seed: Number(args.seed) });
  console.log(`A: ${path.basename(dirA)} (${a.length} utterances)`);
  console.log(`B: ${path.basename(dirB)} (${b.length} utterances)`);
  console.log(`Stage: ${stage}, ${metric === 'content' ? 'content errors' : 'errors including punctuation'}. Difference is B − A (negative means B is better)`);
  if (r.onlyA || r.onlyB || r.truthChanged) console.log(`Excluded utterances: ${r.onlyA} only in A, ${r.onlyB} only in B, ${r.truthChanged} with a changed reference`);
  if (r.provisional) console.log(`Note: ${r.provisional} of the compared utterances have a provisional reference`);
  console.log(formatComparison('All', r.all));
  for (const [name, x] of Object.entries(r.byDataset)) console.log(formatComparison(name, x));
  for (const [name, x] of Object.entries(r.bySplit)) console.log(formatComparison(name === 'dev' ? 'Dev set' : 'Holdout set', x));
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
