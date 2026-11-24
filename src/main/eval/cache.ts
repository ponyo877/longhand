/**
 * 評価の結果の使い回し。音声認識と LLM の結果を、入力から決まるキーで保存する。
 *
 * - 音声認識: 音声のハッシュ、エンジン、モデルとワーカーの大きさと更新時刻、オプション、言語、ヒント、prompt から決まる
 * - LLM: プロバイダの種類、モデル、プロンプト、出力の形式、出力の上限、Anthropic の設定、extraBody、試行番号から決まる。
 *   API キー、ヘッダ、接続先はキーにも保存する中身にも入れない
 * - 失敗は保存しない（次の実行でやり直せるように）
 *
 * 保存先は個人の書き起こしを含むので、リポジトリの外（~/longhand-eval/cache）に 0600 で置く。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LlmSettings } from '../../shared/settings';
import { LlmError, type LlmErrorKind, type LlmProvider, type LlmRequest, type LlmResponse } from '../llm/types';
import { sha256Hex, stableStringify, writePrivate, type FileSig } from './files';

/** キーごとに 1 つの JSON ファイルを置く保存先 */
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
// 音声認識
// ---------------------------------------------------------------------------

/** 書き起こしの手順（pipeline.ts の transcribeLikeApp）を変えたら上げる */
export const ASR_CACHE_VERSION = 2;

export interface AsrKeyInput {
  audioSha256: string;
  engine: string;
  /** モデルのファイル名と、大きさと更新時刻 */
  modelName: string;
  model: FileSig | null;
  worker: FileSig | null;
  /** ワーカーの load.options（default.json の値に設定を重ねたもの） */
  options: Record<string, unknown>;
  language: string;
  hints: readonly string[];
  prompt?: string | null;
  /** 要求に付ける任意の指定（プロンプトの様式、聞き直し、別候補）。既定のままなら undefined（以前のキーと同じになる） */
  extras?: Record<string, unknown>;
  /** 長い録音を区切って書き起こすか（設定の asr.incremental） */
  incremental: boolean;
  /** 書き起こす前に音声の末尾から切り落とした長さ（ms）。切り落とさなければ undefined（キーは変わらない） */
  truncateTailMs?: number;
  /**
   * ヒントが効いた所だけを取り込む書き起こし（asr.hintMode の selective）。
   * いつもヒントありの書き起こしと、ヒントが無い発話では undefined（キーは変わらない）
   */
  hintMode?: 'selective' | 'selective-2';
  /** 書き起こさずに捨てる録音の判定に使う設定 */
  minRecordingMs: number;
  silenceDetection: boolean;
}

export function asrCacheKey(k: AsrKeyInput): string {
  return sha256Hex(stableStringify({ ...k, v: ASR_CACHE_VERSION, hints: [...k.hints], prompt: k.prompt || null }));
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

/** LLM の結果を左右する接続の設定のうち、秘密でないもの。キャッシュのキーと、実行の記録に使う */
export interface LlmIdentity {
  /** プロバイダの種類（anthropic など） */
  kind: string;
  model: string;
  /** Anthropic の設定（effort、thinking、promptCaching）。ほかのプロバイダでは null */
  anthropic: LlmSettings['anthropic'] | null;
  /** extraBody（リクエストに足す JSON）のハッシュ。中身は残さない */
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

/** 1 回の実行で LLM を呼んでよい回数。使い切ったら実行を止める */
export class CallBudget {
  used = 0;

  constructor(readonly max: number) {}

  get exhausted(): boolean {
    return this.used >= this.max;
  }

  /** 1 回分を使う。残っていなければ例外 */
  take(): void {
    if (this.exhausted) throw new Error(`LLM の呼び出しが上限（${this.max} 回）に達しました`);
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

/** 直前の complete の様子（実行の行に残す） */
export interface LlmCallInfo {
  cached: boolean;
  /** LLM の応答にかかった時間（保存済みの結果なら、保存したときの値） */
  elapsedMs: number;
  /** 実際に呼んだ回数（保存済みの結果なら 0） */
  tries: number;
  errorKind?: LlmErrorKind | 'cache-miss' | 'budget';
}

export interface CachingOptions {
  dir: string;
  identity: LlmIdentity;
  /** 試行番号。同じ入力で別の結果を取りたいときに変える */
  attempt?: number;
  budget?: CallBudget;
  /**
   * 呼び出しを、この包みで数えるか（既定は数える）。
   * 通信の入口（fetch）で数えているときは false にする。その場合、この包みは上限に達したかどうかだけを見る
   */
  countCalls?: boolean;
  /** やり直しの回数（timeout、network、rate_limit、5xx）。既定は 2 */
  retries?: number;
  /** やり直す前に待つ時間。テストでは 0 にする */
  backoffMs?: (retry: number, kind: LlmErrorKind) => number;
}

const RETRY_KINDS = new Set<LlmErrorKind>(['timeout', 'network', 'rate_limit']);
const FATAL_KINDS = new Set<LlmErrorKind>(['auth', 'config']);

function retryable(e: LlmError): boolean {
  return RETRY_KINDS.has(e.kind) || (e.kind === 'http' && (e.status ?? 0) >= 500);
}

const defaultBackoff = (retry: number, kind: LlmErrorKind) => (kind === 'rate_limit' ? 10_000 : 1_500) * retry;

/**
 * LlmProvider を包み、結果を保存して使い回す。
 * - 保存済みならそれを返し、LLM は呼ばない
 * - inner が null なら保存済みの結果だけを使う（無ければ失敗を返し、その数を数える）
 * - timeout、network、rate_limit、5xx は retries 回までやり直す
 * - auth と config、呼び出しの上限は、その場で実行を止める印（fatal）を立てる。
 *   formatText は LLM の失敗を握って生テキストに落とすので、呼び出し側は 1 件ごとに fatal を見て止める
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

  /** 直前の complete の様子を取り出して消す。LLM が呼ばれなかった（近道など）なら null */
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
      throw new LlmError('config', '保存済みの結果がありません（保存済みの結果だけを使う指定）');
    }
    const retries = this.opts.retries ?? 2;
    const budget = this.opts.budget;
    let tries = 0;
    for (let retry = 0; ; retry++) {
      if (budget?.exhausted) this.stop('budget', `LLM の呼び出しが上限（${budget.max} 回）に達しました`);
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
