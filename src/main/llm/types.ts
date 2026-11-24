import { t } from '../i18n';

export interface LlmRequest {
  system: string;
  user: string;
  /** Used by providers that support structured output (JSON Schema) */
  jsonSchema?: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  model: string;
  elapsedMs: number;
}

export interface LlmProvider {
  readonly kind: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export type LlmErrorKind =
  | 'config' // settings are missing
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'auth' // 401 / 403
  | 'rate_limit' // 429
  | 'http' // any other HTTP error
  | 'refusal'
  | 'truncated'
  | 'parse';

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Error text for a timeout. It is shown as is in the notification body, so it is written in seconds */
export function timeoutMessage(timeoutMs: number): string {
  return t('engine.llm.timeout', { seconds: Math.max(1, Math.round(timeoutMs / 1000)) });
}

/** Electron's net.fetch, or the global fetch in tests */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
