import { joinUrl } from './http';
import { OpenAiCompatibleProvider } from './openai-compatible';
import { LlmError } from './types';

/**
 * Azure OpenAI（従来のデプロイメント形式）。
 * `POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...`、認証は api-key ヘッダ。
 * 新しい v1 形式（`{endpoint}/openai/v1/chat/completions`）なら openai-compatible で足りる。
 */
export class AzureOpenAiProvider extends OpenAiCompatibleProvider {
  override readonly kind = 'azure-openai';

  protected override endpoint(): string {
    const { baseUrl, azure } = this.cfg;
    if (!baseUrl) throw new LlmError('config', 'Azure のエンドポイントが設定されていません');
    const deployment = azure.deployment || this.cfg.model;
    if (!deployment) throw new LlmError('config', 'デプロイメント名が設定されていません');
    const url = joinUrl(baseUrl, `openai/deployments/${encodeURIComponent(deployment)}/chat/completions`);
    return `${url}?api-version=${encodeURIComponent(azure.apiVersion || '2024-10-21')}`;
  }

  protected override authHeaders(): Record<string, string> {
    return this.apiKey ? { 'api-key': this.apiKey } : {};
  }

  protected override modelField(): Record<string, unknown> {
    // デプロイメントが URL に入るので model は送らない
    return {};
  }
}
