import { t } from '../i18n';
import { joinUrl } from './http';
import { OpenAiCompatibleProvider } from './openai-compatible';
import { LlmError } from './types';

/**
 * Azure OpenAI (the classic deployment form).
 * `POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...`, authenticated with the api-key header.
 * The newer v1 form (`{endpoint}/openai/v1/chat/completions`) works with openai-compatible.
 */
export class AzureOpenAiProvider extends OpenAiCompatibleProvider {
  override readonly kind = 'azure-openai';

  protected override endpoint(): string {
    const { baseUrl, azure } = this.cfg;
    if (!baseUrl) throw new LlmError('config', t('engine.llm.noAzureEndpoint'));
    const deployment = azure.deployment || this.cfg.model;
    if (!deployment) throw new LlmError('config', t('engine.llm.noDeployment'));
    const url = joinUrl(baseUrl, `openai/deployments/${encodeURIComponent(deployment)}/chat/completions`);
    return `${url}?api-version=${encodeURIComponent(azure.apiVersion || '2024-10-21')}`;
  }

  protected override authHeaders(): Record<string, string> {
    return this.apiKey ? { 'api-key': this.apiKey } : {};
  }

  protected override modelField(): Record<string, unknown> {
    // The deployment is in the URL, so model is not sent
    return {};
  }
}
