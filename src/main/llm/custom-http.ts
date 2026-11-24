import type { LlmSettings } from '../../shared/settings';
import { getByPath, postJson } from './http';
import { LlmError, type FetchLike, type LlmProvider, type LlmRequest, type LlmResponse } from './types';

/**
 * 任意の HTTP API。リクエスト本文はテンプレートで組み立て、応答はパスで取り出す。
 * テンプレートの {{system}} {{user}} {{model}} {{max_tokens}} は JSON の値として埋め込む（文字列は引用符付き）。
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
      if (!(k in vars)) throw new LlmError('config', `テンプレートの変数 {{${k}}} は使えません`);
      return JSON.stringify(vars[k]);
    });
    try {
      return JSON.parse(filled);
    } catch (e) {
      throw new LlmError('config', `リクエストのテンプレートが JSON になりません: ${(e as Error).message}`);
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    if (!this.cfg.baseUrl) throw new LlmError('config', '接続先の URL が設定されていません');
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
      throw new LlmError('parse', `応答の ${this.cfg.custom.responsePath} に文字列がありません`);
    }
    return { text: v, model: this.cfg.model, elapsedMs: Date.now() - started };
  }
}
