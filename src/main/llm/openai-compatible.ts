import type { LlmSettings } from '../../shared/settings';
import { t } from '../i18n';
import { getByPath, joinUrl, parseExtraBody, postJson } from './http';
import { LlmError, timeoutMessage, type FetchLike, type LlmProvider, type LlmRequest, type LlmResponse } from './types';

/**
 * OpenAI-compatible Chat Completions (`POST {baseUrl}/chat/completions`).
 * Self-hosted gateways (LiteLLM and others), vLLM, Ollama and LM Studio also connect this way.
 *
 * For options whose support differs by endpoint, a 400 steps down one level and retries, and the result is remembered.
 * - response_format: json_schema -> json_object -> none
 * - max_tokens -> max_completion_tokens (reasoning models reject max_tokens)
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly kind: string = 'openai-compatible';
  private formatLevel: LlmSettings['structuredOutput'];
  private tokenParam: 'max_tokens' | 'max_completion_tokens' = 'max_tokens';

  constructor(
    protected readonly cfg: LlmSettings,
    protected readonly apiKey: string,
    protected readonly fetchImpl: FetchLike,
  ) {
    this.formatLevel = cfg.structuredOutput;
  }

  protected endpoint(): string {
    if (!this.cfg.baseUrl) throw new LlmError('config', t('engine.llm.noUrl'));
    return joinUrl(this.cfg.baseUrl, 'chat/completions');
  }

  protected authHeaders(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  protected modelField(): Record<string, unknown> {
    if (!this.cfg.model) throw new LlmError('config', t('engine.llm.noModel'));
    return { model: this.cfg.model };
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const extra = parseExtraBody(this.cfg.extraBody);
    for (let attempt = 0; attempt < 4; attempt++) {
      const body: Record<string, unknown> = {
        ...this.modelField(),
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        [this.tokenParam]: req.maxOutputTokens,
        stream: false,
      };
      if (req.jsonSchema && this.formatLevel === 'json_schema') {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: 'result', schema: req.jsonSchema, strict: true },
        };
      } else if (req.jsonSchema && this.formatLevel === 'json_object') {
        body.response_format = { type: 'json_object' };
      }
      Object.assign(body, extra);
      try {
        const remaining = req.timeoutMs - (Date.now() - started);
        if (remaining <= 0) throw new LlmError('timeout', timeoutMessage(req.timeoutMs));
        const res = await postJson(this.fetchImpl, this.endpoint(), body, { ...this.authHeaders(), ...this.cfg.headers }, remaining, req.signal);
        const choice = getByPath(res.json, 'choices.0') as Record<string, unknown> | undefined;
        const content = getByPath(choice, 'message.content');
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? '').join('') : '';
        if (choice?.finish_reason === 'length' && !text) throw new LlmError('truncated', t('engine.llm.truncated'));
        if (getByPath(choice, 'message.refusal')) throw new LlmError('refusal', String(getByPath(choice, 'message.refusal')));
        const model = String(getByPath(res.json, 'model') ?? this.cfg.model);
        return { text, model, elapsedMs: Date.now() - started };
      } catch (e) {
        if (!(e instanceof LlmError) || e.kind !== 'http' || e.status !== 400) throw e;
        const m = e.message.toLowerCase();
        // Switch only when the parameter itself is rejected. Switching on errors such as “value too large” leaves no way back
        const unsupported = /unsupported|not supported|unrecognized|unknown|not allowed|not permitted|extra (fields|inputs)|instead|deprecated|invalid parameter/.test(m);
        if (this.tokenParam === 'max_tokens' && m.includes('max_tokens') && (unsupported || m.includes('max_completion_tokens'))) {
          this.tokenParam = 'max_completion_tokens';
          continue;
        }
        if (this.tokenParam === 'max_completion_tokens' && m.includes('max_completion_tokens') && unsupported) {
          // The fallback was rejected too. Switch back and return this error as it is
          this.tokenParam = 'max_tokens';
          throw e;
        }
        if (body.response_format && /response_format|json_schema|json_object|structured output|guided/.test(m)) {
          this.formatLevel = this.formatLevel === 'json_schema' ? 'json_object' : 'none';
          continue;
        }
        throw e;
      }
    }
    throw new LlmError('http', t('engine.llm.retriesExhausted'));
  }
}
