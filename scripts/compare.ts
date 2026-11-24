/**
 * 2 つの評価の実行を比べる。発話を単位にした対のブートストラップで、誤り数の差と 95% 区間を出す。
 *
 *   npx tsx scripts/compare.ts <実行 A> <実行 B> [--stage final] [--metric content]
 *     実行は、~/longhand-eval/runs/ の下のフォルダ名か、フォルダのパス。実行の名前だけを渡すと、その名前の最も新しい実行を使う
 *     --stage <asr|match|noLlm|final>  比べる段階（既定は final。LLM なしの実行どうしなら noLlm）
 *     --metric <content|full>          中身だけか、句読点込みか（既定は content）
 *     --iterations <n>                 取り直しの回数（既定 10000）
 *     --seed <n>                       乱数の種（既定 1）
 *
 * 差は B − A。負なら B のほうが誤りが少ない。出力は数だけ。
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
  if (positionals.length !== 2) throw new Error('使い方: npx tsx scripts/compare.ts <実行 A> <実行 B> [--stage final] [--metric content]');
  const stage = args.stage as StageName;
  const metric = args.metric as CompareMetric;
  if (!STAGES.includes(stage)) throw new Error(`--stage は ${STAGES.join('、')} のどれかにしてください`);
  if (metric !== 'content' && metric !== 'full') throw new Error('--metric は content か full にしてください');
  const [dirA, dirB] = positionals.map(resolveRun);
  const a = readJsonl<RowRecord>(path.join(dirA, 'rows.jsonl'));
  const b = readJsonl<RowRecord>(path.join(dirB, 'rows.jsonl'));
  const r = compareRuns(a, b, { stage, metric, iterations: Number(args.iterations), seed: Number(args.seed) });
  console.log(`A: ${path.basename(dirA)}（${a.length} 件）`);
  console.log(`B: ${path.basename(dirB)}（${b.length} 件）`);
  console.log(`比べる段階: ${stage}、${metric === 'content' ? '中身の誤り' : '句読点込みの誤り'}。差は B − A（負なら B が良い）`);
  if (r.onlyA || r.onlyB || r.truthChanged) console.log(`除いた発話: A にだけある ${r.onlyA} 件、B にだけある ${r.onlyB} 件、正解が変わった ${r.truthChanged} 件`);
  if (r.provisional) console.log(`注意: 比べた発話のうち ${r.provisional} 件は正解が仮です`);
  console.log(formatComparison('全体', r.all));
  for (const [name, x] of Object.entries(r.byDataset)) console.log(formatComparison(name, x));
  for (const [name, x] of Object.entries(r.bySplit)) console.log(formatComparison(name === 'dev' ? '開発用' : '確認用', x));
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
