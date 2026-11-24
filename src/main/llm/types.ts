export interface LlmRequest {
  system: string;
  user: string;
  /** 構造化出力に対応したプロバイダなら使う（JSON Schema） */
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
  | 'config' // 設定が足りない
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'auth' // 401 / 403
  | 'rate_limit' // 429
  | 'http' // そのほかの HTTP エラー
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

/** タイムアウトのエラー文。通知の本文にそのまま出るので秒で書く */
export function timeoutMessage(timeoutMs: number): string {
  return `LLM が ${Math.max(1, Math.round(timeoutMs / 1000))} 秒以内に応答しませんでした`;
}

/** Electron の net.fetch か、テストではグローバルの fetch */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
