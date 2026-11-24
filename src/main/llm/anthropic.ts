import Anthropic from '@anthropic-ai/sdk';
import type { LlmSettings } from '../../shared/settings';
import { t } from '../i18n';
import { parseExtraBody } from './http';
import { LlmError, timeoutMessage, type FetchLike, type LlmProvider, type LlmRequest, type LlmResponse } from './types';

type ThinkingParam = Anthropic.Messages.ThinkingConfigParam;

/**
 * Picks the "turn thinking off" setting per model, because models accept different values.
 * - Claude Sonnet 5.5: {type: "disabled"} returns 400. Turn it off with {type: "between_tools"}
 * - Claude Opus 5.5 / Fable / Mythos: cannot be turned off. Send nothing and keep it shallow with effort
 * - Other Claude models (Haiku 5.5, Sonnet 5, Opus 5, 4.x): {type: "disabled"}
 * - Anything we cannot tell, such as a proxy alias: send nothing
 */
export function thinkingForOff(model: string): ThinkingParam | undefined {
  const m = model.toLowerCase();
  if (m.includes('sonnet-5-5')) return { type: 'between_tools' };
  if (m.includes('opus-5-5') || m.includes('fable') || m.includes('mythos')) return undefined;
  if (/claude-(haiku|sonnet|opus)/.test(m)) return { type: 'disabled' };
  return undefined;
}

/**
 * Anthropic's Messages API. Uses the official SDK and sends requests through Electron's net.fetch
 * (the system proxy settings and custom CAs in the keychain apply as they are).
 *
 * Sampling parameters (temperature and so on) are not sent, because newer models reject them.
 * If effort / thinking / structured output is rejected with 400, the request is retried once without it, and it stays off.
 */
export class AnthropicProvider implements LlmProvider {
  readonly kind = 'anthropic';
  private readonly client: Anthropic;
  private useEffort = true;
  private useThinking = true;
  private useFormat = true;
  /** Whether to ask for a 1-hour prompt cache. If rejected, drop it and fall back to the default (5 minutes) */
  private useLongCache = true;

  constructor(
    private readonly cfg: LlmSettings,
    apiKey: string,
    fetchImpl: FetchLike,
  ) {
    if (!apiKey && !cfg.headers['authorization'] && !cfg.headers['Authorization']) {
      throw new LlmError('config', t('engine.llm.noApiKey'));
    }
    this.client = new Anthropic({
      apiKey: apiKey || null,
      baseURL: cfg.baseUrl || undefined,
      fetch: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
      timeout: cfg.timeoutMs,
      defaultHeaders: cfg.headers,
    });
  }

  private buildParams(req: LlmRequest): Anthropic.Messages.MessageCreateParamsNonStreaming {
    const { anthropic } = this.cfg;
    if (!this.cfg.model) throw new LlmError('config', t('engine.llm.noModel'));
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: this.cfg.model,
      max_tokens: req.maxOutputTokens,
      system: [
        {
          type: 'text',
          text: req.system,
          // Dictation has long gaps, so keep the cache for 1 hour. With 5 minutes, every gap means a re-read and a slower first response
          ...(anthropic.promptCaching ? { cache_control: this.useLongCache ? { type: 'ephemeral' as const, ttl: '1h' as const } : { type: 'ephemeral' as const } } : {}),
        },
      ],
      messages: [{ role: 'user', content: req.user }],
    };
    const outputConfig: Anthropic.Messages.OutputConfig = {};
    if (this.useEffort && anthropic.effort) outputConfig.effort = anthropic.effort;
    if (this.useFormat && req.jsonSchema) outputConfig.format = { type: 'json_schema', schema: req.jsonSchema };
    if (Object.keys(outputConfig).length) params.output_config = outputConfig;
    if (this.useThinking) {
      if (anthropic.thinking === 'off') {
        const t = thinkingForOff(this.cfg.model);
        if (t) params.thinking = t;
      } else if (anthropic.thinking === 'adaptive') {
        params.thinking = { type: 'adaptive' };
      }
    }
    Object.assign(params, parseExtraBody(this.cfg.extraBody));
    return params;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    for (let attempt = 0; attempt < 4; attempt++) {
      const params = this.buildParams(req);
      const remaining = req.timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw new LlmError('timeout', timeoutMessage(req.timeoutMs));
      try {
        const msg = await this.client.messages.create(params, { timeout: remaining, signal: req.signal });
        if (msg.stop_reason === 'refusal') throw new LlmError('refusal', t('engine.llm.refusal'));
        const text = msg.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (msg.stop_reason === 'max_tokens' && !text) throw new LlmError('truncated', t('engine.llm.truncated'));
        return { text, model: msg.model, elapsedMs: Date.now() - started };
      } catch (e) {
        if (e instanceof LlmError) throw e;
        if (e instanceof Anthropic.APIUserAbortError) {
          throw new LlmError('aborted', t('engine.llm.aborted'));
        }
        if (e instanceof Anthropic.APIConnectionTimeoutError) {
          throw new LlmError('timeout', timeoutMessage(req.timeoutMs));
        }
        if (e instanceof Anthropic.APIConnectionError) {
          throw new LlmError('network', t('engine.llm.network', { reason: e.message }));
        }
        if (e instanceof Anthropic.APIError) {
          const status = e.status ?? 0;
          const m = (e.message ?? '').toLowerCase();
          if (status === 400) {
            if (this.useThinking && m.includes('thinking')) {
              this.useThinking = false;
              continue;
            }
            if (this.useEffort && m.includes('effort')) {
              this.useEffort = false;
              continue;
            }
            if (this.useLongCache && (/\bttl\b/.test(m) || m.includes('cache_control'))) {
              this.useLongCache = false;
              continue;
            }
            if (this.useFormat && (m.includes('output_config') || m.includes('format') || m.includes('schema'))) {
              this.useFormat = false;
              continue;
            }
          }
          if (status === 401 || status === 403) throw new LlmError('auth', t('engine.llm.auth', { status, reason: e.message }), status);
          if (status === 429) throw new LlmError('rate_limit', t('engine.llm.rateLimit', { reason: e.message }), status);
          throw new LlmError('http', `HTTP ${status}: ${e.message}`, status);
        }
        throw new LlmError('network', (e as Error).message);
      }
    }
    throw new LlmError('http', t('engine.llm.retriesExhausted'));
  }
}
