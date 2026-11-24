/**
 * Runs an evaluation inside the development app (LONGHAND_EVAL). main.ts loads this only for evaluations.
 *
 * An evaluation that includes the LLM needs the connection settings and the key saved in the app. The key is encrypted with
 * safeStorage (the keychain) and can only be decrypted inside the app. Here the decrypted value is only passed to the LLM calls,
 * and never shown, logged or written to a file.
 *
 * - The real settings file is opened read-only (never written back)
 * - Calls are counted at the network entry point (fetch). Requests over the limit are not sent
 * - The helper, tray, floating bar and regular ASR are not started (main.ts skips the startup for evaluations)
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

/** LLM timeout in evaluations (same as the default in run.ts). Also passed when creating the provider */
const EVAL_LLM_TIMEOUT_MS = 60_000;

/**
 * Runs the evaluation and returns an exit code. 0: done, 2: stopped midway (call limit, authentication error), 3: could not set up the connection
 * realUserData is the app's real data folder (userData before it is moved for the evaluation)
 */
export async function runEvalInApp(spec: string, realUserData: string): Promise<number> {
  const print = (line: string) => console.log(line);
  const config = parseEvalConfig(spec);
  let llm: LlmConnection | undefined;
  if (config.llm !== 'off') {
    const saved = new SettingsStore(path.join(realUserData, 'settings.json'), { readOnly: true });
    const savedLlm = saved.get().llm;
    // Model comparisons replace only the model and the Anthropic settings (effort, thinking). The endpoint and key stay as saved
    const o = config.llmOverride;
    const cfg = o ? ({ ...savedLlm, model: o.model ?? savedLlm.model, anthropic: { ...savedLlm.anthropic, ...o.anthropic } } as typeof savedLlm) : savedLlm;
    const base = { identity: llmIdentity(cfg), maxOutputTokens: cfg.maxOutputTokens, appTimeoutMs: cfg.timeoutMs };
    if (config.llm === 'cache-only') {
      llm = { ...base, provider: null };
    } else {
      const apiKey = saved.getApiKey();
      if (cfg.apiKeyEnc && !apiKey) {
        // getApiKey turns a decryption failure into ''. Empty although a key is saved means it could not be decrypted
        print('Aborted: could not decrypt the saved API key (a key is saved, but the value read back is empty).');
        print('         The evaluation profile (app-profile) may not be able to use the keychain key.');
        return 3;
      }
      if (!isLlmConfigured(cfg, !!apiKey)) {
        print('Aborted: no LLM connection is set up (set one up in Settings > Connection of the development app).');
        return 3;
      }
      const budget = new CallBudget(config.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS);
      // Count at the network entry point. Retries inside the provider (dropping unsupported parameters, for example) also pass here
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
      // Speech recognition models are read from the real data folder, read-only
      modelsDir: path.join(realUserData, 'models'),
      bundledModelsDir: path.join(repoRoot, 'resources', 'models'),
      llm,
      host: `electron ${process.versions.electron}`,
      print,
    });
    return summary.status === 'ok' ? 0 : 2;
  } catch (e) {
    print(`Evaluation failed: ${redact((e as Error).message)}`);
    return 1;
  }
}
