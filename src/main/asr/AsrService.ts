import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { AsrLanguage, AsrResultPayload } from '../../shared/asr-protocol';
import type { AsrSettings } from '../../shared/settings';
import { JsonLinesProcess } from '../JsonLinesProcess';
import { asrLog, createLogger } from '../log';

const log = createLogger('asr');

export type AsrStatus = 'starting' | 'loading' | 'ready' | 'failed' | 'missing';

export interface TranscribeOptions {
  language: AsrLanguage;
  hints: string[];
  prompt?: string;
  /** main の側で組み立てたプロンプトの文（対応しているワーカーだけが使う。asr-protocol の promptText） */
  promptText?: string;
  /** 確信度の低い箇所の別候補を求める */
  alternatives?: { topK: number; below: number };
  /** 条件を変えて聞き直し、別の仮説を求める */
  rehear?: { noHints?: boolean; temperatures?: number[] };
  timeoutMs: number;
  /**
   * 取り消し。待ち行列にあるうちに取り消されたら実行しない。処理中ならワーカーに cancel を送る。
   * どちらの場合も、呼び出し側にはワーカーの応答を待たずに AsrCancelledError で失敗を返す
   */
  signal?: AbortSignal;
}

/** 書き起こしを取り消したときの失敗 */
export class AsrCancelledError extends Error {
  readonly code = 'cancelled';
  constructor() {
    super('書き起こしを取り消しました');
    this.name = 'AsrCancelledError';
  }
}

export function isAsrCancelled(e: unknown): boolean {
  return e instanceof AsrCancelledError || (e as { code?: string } | null)?.code === 'cancelled';
}

/** Float32Array を base64 にする（リトルエンディアン前提。Apple Silicon はリトルエンディアン） */
export function floatToBase64(samples: Float32Array): string {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');
}

export interface ResolvedModel {
  modelPath: string;
  options: Record<string, unknown>;
  description?: string;
}

/** default.json がないときに探す、エンジンごとの既定のモデル（asr/download-models.sh が取得するもの。models/ からの相対パス） */
const BUILTIN_MODELS: Record<string, string> = {
  whisper: 'whisper/ggml-large-v3-turbo-q8_0.bin',
  parakeet: 'parakeet-ja',
};

/** モデルを OS が管理するので、モデルファイルの指定が要らないエンジン */
const OS_MANAGED_MODEL = new Set(['apple']);

/**
 * モデルの場所を決める。設定に明示されていればそれ、なければ models/<engine>/default.json、
 * それもなければエンジンごとの既定のファイル名で models/<engine>/ を探す。
 * 利用者のフォルダ（modelsDir）に見つからなければ、アプリに同梱したフォルダ（bundledDir）を同じ手順で探す。
 */
export function resolveModel(cfg: AsrSettings, modelsDir: string, bundledDir?: string): ResolvedModel | null {
  if (cfg.modelPath) return { modelPath: cfg.modelPath, options: cfg.options };
  const found = resolveIn(cfg, modelsDir, false);
  if (found) return found;
  if (bundledDir) {
    const bundled = resolveIn(cfg, bundledDir, false);
    if (bundled) return bundled;
  }
  return resolveIn(cfg, modelsDir, true);
}

/** 1 つのフォルダの中でモデルを探す。osManaged が true なら、モデルを OS が持つエンジンを「空のパス」で返す */
function resolveIn(cfg: AsrSettings, modelsDir: string, osManaged: boolean): ResolvedModel | null {
  const dir = path.join(modelsDir, cfg.engine);
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'default.json'), 'utf8')) as ResolvedModel;
    const modelPath = m.modelPath && !path.isAbsolute(m.modelPath) ? path.join(dir, m.modelPath) : (m.modelPath ?? '');
    return { modelPath, options: { ...m.options, ...cfg.options }, description: m.description };
  } catch {
    if (osManaged && OS_MANAGED_MODEL.has(cfg.engine)) return { modelPath: '', options: cfg.options, description: 'Apple SpeechTranscriber' };
    const builtin = BUILTIN_MODELS[cfg.engine];
    if (builtin && fs.existsSync(path.join(modelsDir, builtin))) return { modelPath: path.join(modelsDir, builtin), options: cfg.options };
    return null;
  }
}

/**
 * ASR ワーカー（longhand-asr-<engine>）を常駐させ、モデルを読み込んだまま保持する（ASR-1、ASR-2）。
 * 要求は 1 件ずつ順に処理する。ワーカーが落ちたら再起動してモデルを読み直す。
 */
export class AsrService extends EventEmitter {
  private proc: JsonLinesProcess | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** 待ち行列にある要求と処理中の要求の数 */
  private pending = 0;
  private stopping = false;
  private restarts = 0;
  /** 予約中の再起動。二重に予約しないよう 1 つだけ持つ */
  private restartTimer: NodeJS.Timeout | null = null;
  status: AsrStatus = 'starting';
  message = '';
  modelDescription = '';

  constructor(
    private cfg: () => AsrSettings,
    private readonly workerPath: (engine: string) => string,
    private readonly modelsDir: string,
    private readonly language: () => AsrLanguage,
    /** アプリに同梱したモデルのフォルダ（あれば、利用者のフォルダの次に探す） */
    private readonly bundledModelsDir?: string,
  ) {
    super();
  }

  private setStatus(s: AsrStatus, message = ''): void {
    this.status = s;
    this.message = message;
    this.emit('status', s, message);
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    // 前のワーカーが残っていれば止める（モデルを読み込んだまま残さない）
    const old = this.proc;
    this.proc = null;
    old?.kill();
    const cfg = this.cfg();
    const exe = cfg.workerPath || this.workerPath(cfg.engine);
    if (!fs.existsSync(exe)) {
      this.setStatus('missing', `ASR ワーカーが見つかりません: ${exe}（npm run build:asr でビルドしてください）`);
      return;
    }
    const model = resolveModel(cfg, this.modelsDir, this.bundledModelsDir);
    if (!model || (!OS_MANAGED_MODEL.has(cfg.engine) && !model.modelPath)) {
      const how = cfg.engine === 'whisper' ? '設定 > 接続 の「音声認識」からダウンロードしてください' : `asr/download-models.sh --${cfg.engine} で取得してください`;
      this.setStatus('missing', `音声認識のモデルがありません（${path.join(this.modelsDir, cfg.engine)}）。${how}`);
      return;
    }
    if (model.modelPath && !fs.existsSync(model.modelPath)) {
      this.setStatus('missing', `ASR のモデルが見つかりません: ${model.modelPath}`);
      return;
    }
    this.setStatus('starting');
    const proc = new JsonLinesProcess(`asr:${cfg.engine}`, exe, [], (line) => asrLog(line));
    this.proc = proc;
    proc.on('exit', (code, signal) => {
      if (proc !== this.proc || this.stopping) return;
      log.warn(`ASR ワーカーが終了しました（code=${code} signal=${signal}）`);
      this.setStatus('failed', 'ASR ワーカーが終了しました。再起動しています');
      if (this.restarts < 5 && !this.restartTimer) {
        const delay = 1000 * 2 ** this.restarts++;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.stopping) this.start().catch((e) => log.error('ASR の再起動に失敗', e));
        }, delay);
      }
    });
    try {
      await proc.start(15000);
      this.setStatus('loading');
      const loaded = await proc.request('load', { modelPath: model.modelPath, language: this.language(), options: model.options }, 120000);
      const p = loaded.payload as { elapsedMs: number; model: string };
      this.modelDescription = p.model || model.description || '';
      log.info(`ASR のモデルを読み込みました（${this.modelDescription}、${p.elapsedMs}ms）`);
      this.restarts = 0;
      this.setStatus('ready');
      // ウォームアップ（初回推論の遅さを録音のたびに払わないように）
      this.transcribe(new Float32Array(16000 * 0.5), { language: this.language(), hints: [], timeoutMs: 30000 }).catch(() => undefined);
    } catch (e) {
      log.error('ASR ワーカーの起動に失敗しました', e);
      this.setStatus('failed', (e as Error).message);
      proc.kill();
    }
  }

  async restart(): Promise<void> {
    this.stop();
    await new Promise((r) => setTimeout(r, 300));
    this.restarts = 0;
    await this.start();
  }

  get ready(): boolean {
    return this.status === 'ready' && !!this.proc?.running;
  }

  /** 待ち行列が空で、処理中の要求もない */
  get idle(): boolean {
    return this.pending === 0;
  }

  /** 準備ができるまで待つ（最大 timeoutMs）。準備ができたら true */
  waitReady(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (this.status === 'missing') return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.off('status', onStatus);
        signal?.removeEventListener('abort', onAbort);
        resolve(ok);
      };
      const onStatus = () => {
        if (this.ready) done(true);
        else if (this.status === 'missing') done(false);
      };
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(this.ready), timeoutMs);
      this.on('status', onStatus);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** 音声を書き起こす。要求は順に処理する */
  transcribe(samples: Float32Array, opts: TranscribeOptions): Promise<AsrResultPayload> {
    const signal = opts.signal;
    const run = async () => {
      if (signal?.aborted) throw new AsrCancelledError();
      const proc = this.proc;
      if (!proc?.running || this.status !== 'ready') throw new Error(this.message || 'ASR が準備できていません');
      if (samples.length === 0) return { text: '', elapsedMs: 0 };
      // 処理中に取り消されたらワーカーに知らせる。対応していないワーカーは最後まで処理して結果を返す
      const onAbort = () => proc.send('cancel', {});
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await proc.request(
          'transcribe',
          {
            pcm: floatToBase64(samples),
            language: opts.language,
            hints: opts.hints.slice(0, 64),
            prompt: opts.prompt,
            promptText: opts.promptText,
            alternatives: opts.alternatives,
            rehear: opts.rehear,
          },
          opts.timeoutMs,
        );
        return res.payload as AsrResultPayload;
      } catch (e) {
        if (isAsrCancelled(e)) throw new AsrCancelledError();
        // 時間切れでもワーカーは処理を続けていて、次の要求と重なる。止めて起動し直す（exit で再起動する）
        if ((e as { code?: string }).code === 'timeout' && proc === this.proc) {
          log.warn('ASR が時間内に応答しないので、ワーカーを起動し直します');
          proc.kill();
        }
        throw e;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    };
    return this.enqueue(run, signal);
  }

  /**
   * 要求を待ち行列に入れる。次の要求は、ワーカーが実際に応答するまで送らない
   * （取り消しても、ワーカーの処理が終わるまで待ち行列は進まない）
   */
  private enqueue<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const job = this.queue.then(run, run);
    this.pending++;
    const settle = () => {
      this.pending--;
    };
    job.then(settle, settle);
    this.queue = job.catch(() => undefined);
    if (!signal) return job;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new AsrCancelledError());
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      job.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.proc?.kill();
    this.proc = null;
  }
}
