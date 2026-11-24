import type { LlmSettings } from '../../shared/settings';
import { t } from '../i18n';
import { getByPath, postJson } from './http';
import { LlmError, type FetchLike, type LlmProvider, type LlmRequest, type LlmResponse } from './types';

/**
 * Any HTTP API. The request body is built from a template, and the result is read from the response by a path.
 * {{system}} {{user}} {{model}} {{max_tokens}} in the template are filled in as JSON values (strings with quotes).
 */
export class CustomHttpProvider implements LlmProvider {
  readonly kind = 'custom-http';

  constructor(
    private readonly cfg: LlmSettings,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike,
  ) {}

  static render(template: string, vars: Record<string, unknown>): unknown {
    const filled = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => {
      if (!(k in vars)) throw new LlmError('config', t('engine.llm.unknownTemplateVariable', { variable: `{{${k}}}` }));
      return JSON.stringify(vars[k]);
    });
    try {
      return JSON.parse(filled);
    } catch (e) {
      throw new LlmError('config', t('engine.llm.templateNotJson', { reason: (e as Error).message }));
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    if (!this.cfg.baseUrl) throw new LlmError('config', t('engine.llm.noUrl'));
    const body = CustomHttpProvider.render(this.cfg.custom.bodyTemplate, {
      system: req.system,
      user: req.user,
      model: this.cfg.model,
      max_tokens: req.maxOutputTokens,
    });
    const headers: Record<string, string> = { ...this.cfg.headers };
    if (this.apiKey && this.cfg.custom.authHeader) {
      headers[this.cfg.custom.authHeader.toLowerCase()] = `${this.cfg.custom.authPrefix}${this.apiKey}`;
    }
    const res = await postJson(this.fetchImpl, this.cfg.baseUrl, body, headers, req.timeoutMs, req.signal);
    const v = getByPath(res.json ?? res.text, this.cfg.custom.responsePath);
    if (typeof v !== 'string') {
      throw new LlmError('parse', t('engine.llm.noStringAtPath', { path: this.cfg.custom.responsePath }));
    }
    return { text: v, model: this.cfg.model, elapsedMs: Date.now() - started };
  }
}
