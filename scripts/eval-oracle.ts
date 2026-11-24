/**
 * 別候補の見込みを計算する。聞き直しと別候補（行の asr.uncertain）が、どれだけ役に立ちうるかを見積もる。
 *
 *   npx tsx scripts/eval-oracle.ts <実行> [<実行> …]
 *     実行は、~/longhand-eval/runs/ の下のフォルダ名か、フォルダのパス。実行の名前だけを渡すと、その名前の最も新しい実行を使う
 *     （聞き直しか別候補を求めた実行を渡す。例: asr-rehear、asr-vocab-rehear）
 *
 * 箇所ごとに、書き起こしの中の語句を候補に置き換えてみて、正解との編集距離（中身）が減る候補だけを採った場合の誤りを出す。
 * 正解を見て選ぶので、実際の整形が届く上限である。比べる相手として、どの箇所でも 1 番目の候補を採った場合も出す。
 * 出力は数だけ（文は出さない）。
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveRunDir } from '../src/main/eval/config';
import { evalRoot, readJsonl } from '../src/main/eval/files';
import { formatOracle, oracleSummary } from '../src/main/eval/oracle';
import type { RowRecord } from '../src/main/eval/score';

const { positionals } = parseArgs({ allowPositionals: true, options: {} });

function main(): void {
  if (!positionals.length) throw new Error('使い方: npx tsx scripts/eval-oracle.ts <実行> [<実行> …]');
  const runs = path.join(evalRoot(), 'runs');
  for (const spec of positionals) {
    const dir = resolveRunDir(spec, runs);
    const rows = readJsonl<RowRecord>(path.join(dir, 'rows.jsonl'));
    console.log(`実行: ${path.basename(dir)}（${rows.length} 件）`);
    const provisional = rows.filter((r) => r.provisional).length;
    if (provisional) console.log(`注意: ${provisional} 件は正解が仮です`);
    if (!rows.some((r) => r.asr.uncertain?.length)) {
      console.log('  聞き違いかもしれない箇所のある発話がありません（聞き直しか別候補を求めた実行を渡してください）');
      continue;
    }
    for (const l of formatOracle('全体', oracleSummary(rows))) console.log(l);
    const datasets = [...new Set(rows.map((r) => r.dataset))].sort();
    if (datasets.length > 1) for (const d of datasets) for (const l of formatOracle(d, oracleSummary(rows.filter((r) => r.dataset === d)))) console.log(l);
  }
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
