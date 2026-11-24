/**
 * 評価を走らせる（LLM なし、または保存済みの LLM の結果だけで）。
 *
 *   npx tsx scripts/eval-run.ts --name base --datasets user-v1,user-v2 --llm off
 *   npx tsx scripts/eval-run.ts --name base --datasets user-v1,user-v2 --llm cache-only
 *     --config <json>      設定のファイル（src/main/eval/run.ts の EvalConfig）。ほかの引数で上書きできる
 *     --name <名前>         実行の名前（結果のフォルダ名に入る）
 *     --datasets <a,b>     データセットの名前（~/longhand-eval/datasets/ の下）
 *     --llm <off|cache-only>  off は LLM なし。cache-only は、アプリの中で測ったときの保存済みの結果だけで集計し直す
 *     --vocab <file>       辞書の語（1 行 1 語。評価用の一覧は ~/longhand-eval/hints.txt）。無ければ辞書なし
 *     --readings <file>    読み（1 行に「語<TAB>読み,読み」）。確かめた読みとして扱う
 *     --settings <json>    アプリの既定の設定への上書き（JSON そのものか、ファイル）。例: '{"llmFastPath":false}'
 *     --split <dev|holdout|all>  開発用か確認用だけを測る
 *     --limit <n> / --ids <a,b>  発話を絞る
 *     --attempt <n>        LLM の試行番号（保存済みの結果のキーに入る）
 *     --asr cache-only     音声認識を動かさず、保存済みの結果だけを使う
 *     --recent <previous|none>  辞書の語の得点に使う「最近の書き起こし」
 *     --truncate-tail <postRoll|ms>  書き起こす前に、音声の末尾を切り落とす（実験用）。postRoll は、行ごとの「キーを離した後に録った長さ」
 *                          の分だけ。数値は、どの行もその長さ（ms）だけ。同じ録音で、離した後の録音の有無を比べる
 *
 * LLM を実際に呼ぶ評価は、開発版のアプリの中で走らせる（アプリに保存した接続設定とキーを使う。キーは読み出さない）:
 *   LONGHAND_EVAL='{"name":"base","datasets":["user-v1","user-v2"],"llm":"live"}' npm start
 *   （開発版がすでに動いていて .vite/build が新しければ、LONGHAND_EVAL=… npx electron . でもよい）
 *
 * 標準出力には数だけを出す。発話ごとの文は ~/longhand-eval/runs/<実行>/rows.jsonl にだけ書く。
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
