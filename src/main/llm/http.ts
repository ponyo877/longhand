import { t as translate } from '../i18n';
import { LlmError, timeoutMessage, type FetchLike } from './types';

/** Combines the timeout and the caller's abort into one AbortSignal */
export function timeoutSignal(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new Error('timeout'));
  }, timeoutMs);
  const onAbort = () => ctrl.abort(outer?.reason ?? new Error('aborted'));
  if (outer) {
    if (outer.aborted) onAbort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
    timedOut: () => timedOut,
  };
}

export interface PostJsonResult {
  status: number;
  json: unknown;
  text: string;
}

/** POSTs JSON and returns the response. HTTP errors become LlmError */
export async function postJson(fetchImpl: FetchLike, url: string, body: unknown, headers: Record<string, string>, timeoutMs: number, outer?: AbortSignal): Promise<PostJsonResult> {
  const t = timeoutSignal(timeoutMs, outer);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: t.signal,
      });
    } catch (e) {
      if (t.timedOut()) throw new LlmError('timeout', timeoutMessage(timeoutMs));
      if (outer?.aborted) throw new LlmError('aborted', translate('engine.llm.aborted'));
      throw new LlmError('network', translate('engine.llm.network', { reason: (e as Error).message }));
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      if (t.timedOut()) throw new LlmError('timeout', timeoutMessage(timeoutMs));
      throw new LlmError('network', translate('engine.llm.readFailed', { reason: (e as Error).message }));
    }
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* not a JSON response */
    }
    if (!res.ok) throw httpError(res.status, json, text);
    return { status: res.status, json, text };
  } finally {
    t.cleanup();
  }
}

export function httpError(status: number, json: unknown, text: string): LlmError {
  const msg = extractErrorMessage(json) ?? text.slice(0, 300);
  if (status === 401 || status === 403) return new LlmError('auth', translate('engine.llm.auth', { status, reason: msg }), status);
  if (status === 429) return new LlmError('rate_limit', translate('engine.llm.rateLimit', { reason: msg }), status);
  return new LlmError('http', `HTTP ${status}: ${msg}`, status);
}

function extractErrorMessage(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const j = json as Record<string, unknown>;
  const err = j.error as Record<string, unknown> | string | undefined;
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string') return err.message;
  if (typeof j.message === 'string') return j.message;
  if (typeof j.detail === 'string') return j.detail;
  return undefined;
}

/** Reads a value by a path such as "choices.0.message.content" */
export function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.').filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[key];
    else return undefined;
  }
  return cur;
}

/** Parses extraBody (a JSON string) from the settings. Throws if it is malformed */
export function parseExtraBody(extra: string): Record<string, unknown> {
  if (!extra.trim()) return {};
  const v = JSON.parse(extra);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new LlmError('config', translate('engine.llm.extraBodyNotObject'));
  return v as Record<string, unknown>;
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}
