/**
 * 開発版のアプリの中で評価を走らせる（LONGHAND_EVAL）。main.ts から、評価のときだけ読み込む。
 *
 * LLM を含めた評価は、アプリに保存済みの接続設定とキーを使う必要がある。キーは safeStorage（キーチェーン）で
 * 暗号化してあり、アプリの中でしか復号できない。ここでは復号した値を LLM の呼び出しに渡すだけで、
 * 表示にも、ログにも、ファイルにも出さない。
 *
 * - 実際の設定ファイルは読み取りだけで開く（書き戻さない）
 * - 呼び出しの回数は、通信の入口（fetch）で数える。上限を超える通信は送らない
 * - ヘルパー、トレイ、フローティングバー、通常の ASR は起動しない（main.ts が、評価のときは起動の処理を通さない）
 */
import path from 'node:path';
import { app } from 'electron';
import { CallBudget, llmIdentity } from './eval/cache';
import { parseEvalConfig } from './eval/config';
import { evalRoot } from './eval/files';
import { DEFAULT_MAX_LLM_CALLS, runEval, type LlmConnection } from './eval/run';
import { createProvider, isLlmConfigured } from './llm';
import type { FetchLike } from './llm/types';
import { redact } from './log';
import { llmFetch } from './net/egress';
import { SettingsStore } from './store/settings';

/** 評価での LLM の時間切れ（run.ts の既定と同じ）。プロバイダの作成時にも渡す */
const EVAL_LLM_TIMEOUT_MS = 60_000;

/**
 * 評価を走らせ、終了コードを返す。0: 完了、2: 途中で止めた（呼び出しの上限、認証の誤り）、3: 接続を用意できなかった
 * realUserData は、アプリの実際の保存先（評価用に移す前の userData）
 */
export async function runEvalInApp(spec: string, realUserData: string): Promise<number> {
  const print = (line: string) => console.log(line);
  const config = parseEvalConfig(spec);
  let llm: LlmConnection | undefined;
  if (config.llm !== 'off') {
    const saved = new SettingsStore(path.join(realUserData, 'settings.json'), { readOnly: true });
    const savedLlm = saved.get().llm;
    // モデルの比較では、モデルと、Anthropic の設定（effort、thinking）だけを差し替える。接続先とキーは保存済みのまま
    const o = config.llmOverride;
    const cfg = o ? ({ ...savedLlm, model: o.model ?? savedLlm.model, anthropic: { ...savedLlm.anthropic, ...(o.anthropic ?? {}) } } as typeof savedLlm) : savedLlm;
    const base = { identity: llmIdentity(cfg), maxOutputTokens: cfg.maxOutputTokens, appTimeoutMs: cfg.timeoutMs };
    if (config.llm === 'cache-only') {
      llm = { ...base, provider: null };
    } else {
      const apiKey = saved.getApiKey();
      if (cfg.apiKeyEnc && !apiKey) {
        // getApiKey は復号の失敗を空文字にする。キーが保存されているのに空なら、復号できていない
        print('中止: 保存済みの API キーを復号できませんでした（キーは保存されているのに、取り出した値が空です）。');
        print('      評価用の保存先（app-profile）からは、キーチェーンの鍵を使えていない可能性があります。');
        return 3;
      }
      if (!isLlmConfigured(cfg, !!apiKey)) {
        print('中止: LLM の接続が設定されていません（開発版の 設定 > 接続 で設定してください）。');
        return 3;
      }
      const budget = new CallBudget(config.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS);
      // 通信の入口で数える。プロバイダが内部でやり直す分（対応していない引数を外すなど）も、ここを通る
      const countingFetch: FetchLike = (input, init) => {
        budget.take();
        return llmFetch(input, init);
      };
      const provider = createProvider({ ...cfg, timeoutMs: config.llmTimeoutMs ?? EVAL_LLM_TIMEOUT_MS }, apiKey, countingFetch);
      llm = { ...base, provider, budget };
    }
  }
  const repoRoot = app.getAppPath();
  try {
    const { summary } = await runEval(config, {
      root: evalRoot(),
      repoRoot,
      // 音声認識のモデルは、実際の保存先のものを読むだけで使う
      modelsDir: path.join(realUserData, 'models'),
      bundledModelsDir: path.join(repoRoot, 'resources', 'models'),
      llm,
      host: `electron ${process.versions.electron}`,
      print,
    });
    return summary.status === 'ok' ? 0 : 2;
  } catch (e) {
    print(`評価に失敗しました: ${redact((e as Error).message)}`);
    return 1;
  }
}
