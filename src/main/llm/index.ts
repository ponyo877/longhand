import type { LlmSettings } from '../../shared/settings';
import { AnthropicProvider } from './anthropic';
import { AzureOpenAiProvider } from './azure-openai';
import { CustomHttpProvider } from './custom-http';
import { OpenAiCompatibleProvider } from './openai-compatible';
import { LlmError, type FetchLike, type LlmProvider } from './types';

export * from './types';

/**
 * 設定から LlmProvider を作る。外部への通信はこのモジュール配下からだけ行う（OPS-1）。
 * fetchImpl には Electron の net.fetch を渡す（OPS-2）。
 */
export function createProvider(cfg: LlmSettings, apiKey: string, fetchImpl: FetchLike): LlmProvider {
  switch (cfg.provider) {
    case 'openai-compatible':
      return new OpenAiCompatibleProvider(cfg, apiKey, fetchImpl);
    case 'azure-openai':
      return new AzureOpenAiProvider(cfg, apiKey, fetchImpl);
    case 'anthropic':
      return new AnthropicProvider(cfg, apiKey, fetchImpl);
    case 'custom-http':
      return new CustomHttpProvider(cfg, apiKey, fetchImpl);
    default:
      throw new LlmError('config', `未知のプロバイダです: ${String((cfg as { provider: unknown }).provider)}`);
  }
}

/** LLM の設定が最低限そろっているか */
export function isLlmConfigured(cfg: LlmSettings, hasKey: boolean): boolean {
  if (!cfg.model && cfg.provider !== 'azure-openai' && cfg.provider !== 'custom-http') return false;
  if (cfg.provider === 'anthropic') return hasKey || !!cfg.headers['authorization'] || !!cfg.headers['Authorization'];
  if (cfg.provider === 'azure-openai') return !!cfg.baseUrl && !!(cfg.azure.deployment || cfg.model);
  return !!cfg.baseUrl;
}
