/**
 * Reuse of evaluation results. Speech recognition and LLM results are saved under a key determined by their inputs.
 *
 * - Speech recognition: determined by the audio hash, the engine, the size and modification time of the model and the worker, the options, the language, the hints and the prompt
 * - LLM: determined by the provider kind, the model, the prompt, the output format, the output limit, the Anthropic settings, extraBody and the attempt number.
 *   The API key, headers and endpoint go into neither the key nor the saved content
 * - Failures are not saved (so that the next run can retry them)
 *
 * The cache holds personal transcripts, so it lives outside the repository (~/longhand-eval/cache) with mode 0600.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LlmSettings } from '../../shared/settings';
import { LlmError, type LlmErrorKind, type LlmProvider, type LlmRequest, type LlmResponse } from '../llm/types';
import { sha256Hex, stableStringify, writePrivate, type FileSig } from './files';

/** Storage with one JSON file per key */
export class JsonCache<T> {
  constructor(private readonly dir: string) {}

  private file(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  get(key: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(this.file(key), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  set(key: string, value: T): void {
    writePrivate(this.file(key), JSON.stringify(value));
  }
}

// ---------------------------------------------------------------------------
// Speech recognition
// ---------------------------------------------------------------------------

/** Bump this when the transcription steps (transcribeLikeApp in pipeline.ts) change */
export const ASR_CACHE_VERSION = 2;

export interface AsrKeyInput {
  audioSha256: string;
  engine: string;
  /** File name of the model, and its size and modification time */
  modelName: string;
  model: FileSig | null;
  worker: FileSig | null;
  /** The worker's load.options (the values in default.json with the settings applied on top) */
  options: Record<string, unknown>;
  language: string;
  hints: readonly string[];
  prompt?: string | null;
  /** Optional settings added to the request (prompt style, rehearing, alternatives). undefined when left at the defaults (the key stays the same as before) */
  extras?: Record<string, unknown>;
  /** Whether long recordings are transcribed in segments (the asr.incremental setting) */
  incremental: boolean;
  /** Length cut from the end of the audio before transcribing (ms). undefined when nothing is cut (the key does not change) */
  truncateTailMs?: number;
  /**
   * Transcription that takes only the parts where the hints helped (asr.hintMode selective).
   * undefined for transcription that always uses hints, and for utterances without hints (the key does not change)
   */
  hintMode?: 'selective' | 'selective-2';
  /** Settings used to decide which recordings are dropped without transcribing */
  minRecordingMs: number;
  silenceDetection: boolean;
}

export function asrCacheKey(k: AsrKeyInput): string {
  return sha256Hex(stableStringify({ ...k, v: ASR_CACHE_VERSION, hints: [...k.hints], prompt: k.prompt || null }));
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

/** The non-secret connection settings that affect LLM results. Used for the cache key and for the run record */
export interface LlmIdentity {
  /** Provider kind (anthropic and so on) */
  kind: string;
  model: string;
  /** Anthropic settings (effort, thinking, promptCaching). null for other providers */
  anthropic: LlmSettings['anthropic'] | null;
  /** Hash of extraBody (JSON added to the request). The content itself is not kept */
  extraBodySha256: string;
}

export function llmIdentity(cfg: LlmSettings): LlmIdentity {
  return {
    kind: cfg.provider,
    model: cfg.provider === 'azure-openai' ? cfg.azure.deployment || cfg.model : cfg.model,
    anthropic: cfg.provider === 'anthropic' ? { ...cfg.anthropic } : null,
    extraBodySha256: sha256Hex(cfg.extraBody ?? ''),
  };
}

export function llmCacheKey(id: LlmIdentity, req: Pick<LlmRequest, 'system' | 'user' | 'jsonSchema' | 'maxOutputTokens'>, attempt = 0): string {
  return sha256Hex(
    stableStringify({
      v: 1,
      kind: id.kind,
      model: id.model,
      system: req.system,
      user: req.user,
      jsonSchema: req.jsonSchema ?? null,
      maxOutputTokens: req.maxOutputTokens,
      anthropic: id.anthropic,
      extraBody: id.extraBodySha256,
      attempt,
    }),
  );
}

/** Number of LLM calls allowed in one run. The run stops when they are used up */
export class CallBudget {
  used = 0;

  constructor(readonly max: number) {}

  get exhausted(): boolean {
    return this.used >= this.max;
  }

  /** Uses one call. Throws when none are left */
  take(): void {
    if (this.exhausted) throw new Error(`LLM call limit reached (${this.max} calls)`);
    this.used++;
  }
}

interface LlmCacheEntry {
  v: 1;
  kind: string;
  model: string;
  attempt: number;
  response: LlmResponse;
  createdAt: string;
}

/** How the last complete went (kept in the run's row) */
export interface LlmCallInfo {
  cached: boolean;
  /** Time the LLM took to respond (for a saved result, the value from when it was saved) */
  elapsedMs: number;
  /** Number of actual calls (0 for a saved result) */
  tries: number;
  errorKind?: LlmErrorKind | 'cache-miss' | 'budget';
}

export interface CachingOptions {
  dir: string;
  identity: LlmIdentity;
  /** Attempt number. Change it to get a different result for the same input */
  attempt?: number;
  budget?: CallBudget;
  /**
   * Whether this wrapper counts the calls (it does by default).
   * Set to false when calls are counted at the network entry point (fetch). This wrapper then only checks whether the limit is reached
   */
  countCalls?: boolean;
  /** Number of retries (timeout, network, rate_limit, 5xx). Defaults to 2 */
  retries?: number;
  /** Time to wait before a retry. 0 in tests */
  backoffMs?: (retry: number, kind: LlmErrorKind) => number;
}

const RETRY_KINDS = new Set<LlmErrorKind>(['timeout', 'network', 'rate_limit']);
const FATAL_KINDS = new Set<LlmErrorKind>(['auth', 'config']);

function retryable(e: LlmError): boolean {
  return RETRY_KINDS.has(e.kind) || (e.kind === 'http' && (e.status ?? 0) >= 500);
}

const defaultBackoff = (retry: number, kind: LlmErrorKind) => (kind === 'rate_limit' ? 10_000 : 1_500) * retry;

/**
 * Wraps an LlmProvider and saves its results for reuse.
 * - Returns a saved result when there is one, without calling the LLM
 * - When inner is null, uses saved results only (returns a failure when there is none, and counts it)
 * - Retries timeout, network, rate_limit and 5xx up to `retries` times
 * - auth, config and the call limit set a flag (fatal) that stops the run at once.
 *   formatText swallows LLM failures and falls back to the raw text, so the caller checks fatal after each item and stops
 */
export class CachingProvider implements LlmProvider {
  readonly kind: string;
  readonly stats = { hits: 0, misses: 0, calls: 0, stored: 0, failures: 0 };
  fatal: { kind: 'auth' | 'config' | 'budget'; message: string } | null = null;
  private last: LlmCallInfo | null = null;
  private readonly cache: JsonCache<LlmCacheEntry>;
  private readonly attempt: number;

  constructor(
    private readonly inner: LlmProvider | null,
    private readonly opts: CachingOptions,
  ) {
    this.kind = opts.identity.kind;
    this.cache = new JsonCache<LlmCacheEntry>(opts.dir);
    this.attempt = opts.attempt ?? 0;
  }

  /** Takes and clears how the last complete went. null when the LLM was not called (a shortcut, for example) */
  takeLast(): LlmCallInfo | null {
    const l = this.last;
    this.last = null;
    return l;
  }

  private stop(kind: 'auth' | 'config' | 'budget', message: string): never {
    this.fatal = { kind, message };
    this.last = { cached: false, elapsedMs: 0, tries: 0, errorKind: kind };
    throw new LlmError(kind === 'budget' ? 'config' : kind, message);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (this.fatal) throw new LlmError('config', this.fatal.message);
    const key = llmCacheKey(this.opts.identity, req, this.attempt);
    const hit = this.cache.get(key);
    if (hit?.response && typeof hit.response.text === 'string') {
      this.stats.hits++;
      this.last = { cached: true, elapsedMs: hit.response.elapsedMs, tries: 0 };
      return hit.response;
    }
    this.stats.misses++;
    if (!this.inner) {
      this.last = { cached: false, elapsedMs: 0, tries: 0, errorKind: 'cache-miss' };
      throw new LlmError('config', 'No saved result (only saved results are allowed)');
    }
    const retries = this.opts.retries ?? 2;
    const budget = this.opts.budget;
    let tries = 0;
    for (let retry = 0; ; retry++) {
      if (budget?.exhausted) this.stop('budget', `LLM call limit reached (${budget.max} calls)`);
      if (budget && this.opts.countCalls !== false) budget.take();
      this.stats.calls++;
      tries++;
      try {
        const res = await this.inner.complete(req);
        const response: LlmResponse = { text: res.text, model: res.model, elapsedMs: res.elapsedMs };
        this.cache.set(key, { v: 1, kind: this.kind, model: this.opts.identity.model, attempt: this.attempt, response, createdAt: new Date().toISOString() });
        this.stats.stored++;
        this.last = { cached: false, elapsedMs: res.elapsedMs, tries };
        return response;
      } catch (e) {
        const err = e instanceof LlmError ? e : new LlmError('network', (e as Error).message);
        if (FATAL_KINDS.has(err.kind)) this.stop(err.kind as 'auth' | 'config', err.message);
        if (retryable(err) && retry < retries) {
          const wait = (this.opts.backoffMs ?? defaultBackoff)(retry + 1, err.kind);
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        this.stats.failures++;
        this.last = { cached: false, elapsedMs: 0, tries, errorKind: err.kind };
        throw err;
      }
    }
  }
}
