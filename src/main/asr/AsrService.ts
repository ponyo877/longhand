import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { AsrLanguage, AsrResultPayload } from '../../shared/asr-protocol';
import type { AsrSettings } from '../../shared/settings';
import { JsonLinesProcess } from '../JsonLinesProcess';
import { t } from '../i18n';
import { asrLog, createLogger } from '../log';

const log = createLogger('asr');

export type AsrStatus = 'starting' | 'loading' | 'ready' | 'failed' | 'missing';

export interface TranscribeOptions {
  language: AsrLanguage;
  hints: string[];
  prompt?: string;
  /** Prompt text built on the main side (only workers that support it use it; promptText in asr-protocol) */
  promptText?: string;
  /** Asks for alternative candidates where confidence is low */
  alternatives?: { topK: number; below: number };
  /** Asks the worker to listen again under different conditions and return other hypotheses */
  rehear?: { noHints?: boolean; temperatures?: number[] };
  timeoutMs: number;
  /**
   * Cancellation. A request canceled while still in the queue is never run. A request in progress sends cancel to the worker.
   * Either way, the caller gets an AsrCancelledError right away without waiting for the worker's reply
   */
  signal?: AbortSignal;
}

/** The error for a canceled transcription */
export class AsrCancelledError extends Error {
  readonly code = 'cancelled';
  constructor() {
    super(t('asr.cancelled'));
    this.name = 'AsrCancelledError';
  }
}

export function isAsrCancelled(e: unknown): boolean {
  return e instanceof AsrCancelledError || (e as { code?: string } | null)?.code === 'cancelled';
}

/** Encodes a Float32Array as base64 (assumes little-endian, which Apple Silicon is) */
export function floatToBase64(samples: Float32Array): string {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');
}

export interface ResolvedModel {
  modelPath: string;
  options: Record<string, unknown>;
  description?: string;
}

/** Default model per engine, looked for when there is no default.json (the ones asr/download-models.sh fetches; relative to models/) */
const BUILTIN_MODELS: Record<string, string> = {
  whisper: 'whisper/ggml-large-v3-turbo-q8_0.bin',
  parakeet: 'parakeet-ja',
};

/** Engines whose model the OS manages, so they need no model file */
const OS_MANAGED_MODEL = new Set(['apple']);

/**
 * Decides where the model is. The path set in the settings if there is one, otherwise models/<engine>/default.json,
 * otherwise the engine's default file name in models/<engine>/.
 * If nothing is found in the user's folder (modelsDir), the folder bundled with the app (bundledDir) is searched the same way.
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

/** Looks for the model in one folder. When osManaged is true, an engine whose model the OS holds is returned with an empty path */
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
 * Keeps the ASR worker (longhand-asr-<engine>) running with the model loaded (ASR-1, ASR-2).
 * Requests are handled one at a time in order. If the worker dies, it is restarted and the model is loaded again.
 */
export class AsrService extends EventEmitter {
  private proc: JsonLinesProcess | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Number of requests in the queue and in progress */
  private pending = 0;
  private stopping = false;
  private restarts = 0;
  /** The scheduled restart. Only one is kept so that a restart is never scheduled twice */
  private restartTimer: NodeJS.Timeout | null = null;
  status: AsrStatus = 'starting';
  /** Status text, kept as a function so that it follows the interface language when that changes */
  private messageText: () => string = () => '';
  modelDescription = '';

  constructor(
    private cfg: () => AsrSettings,
    private readonly workerPath: (engine: string) => string,
    private readonly modelsDir: string,
    private readonly language: () => AsrLanguage,
    /** Folder of the models bundled with the app (if given, searched after the user's folder) */
    private readonly bundledModelsDir?: string,
  ) {
    super();
  }

  /** Status text in the current interface language ('' when there is nothing to say) */
  get message(): string {
    return this.messageText();
  }

  private setStatus(s: AsrStatus, message: () => string = () => ''): void {
    this.status = s;
    this.messageText = message;
    this.emit('status', s, this.message);
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    // Stop the previous worker if it is still there (do not leave a model loaded)
    const old = this.proc;
    this.proc = null;
    old?.kill();
    const cfg = this.cfg();
    const exe = cfg.workerPath || this.workerPath(cfg.engine);
    if (!fs.existsSync(exe)) {
      this.setStatus('missing', () => t('asr.workerMissing', { path: exe }));
      return;
    }
    const model = resolveModel(cfg, this.modelsDir, this.bundledModelsDir);
    if (!model || (!OS_MANAGED_MODEL.has(cfg.engine) && !model.modelPath)) {
      const dir = path.join(this.modelsDir, cfg.engine);
      this.setStatus('missing', () => (cfg.engine === 'whisper' ? t('asr.modelMissing.download', { dir }) : t('asr.modelMissing.script', { dir, engine: cfg.engine })));
      return;
    }
    if (model.modelPath && !fs.existsSync(model.modelPath)) {
      this.setStatus('missing', () => t('asr.modelFileMissing', { path: model.modelPath }));
      return;
    }
    this.setStatus('starting');
    const proc = new JsonLinesProcess(`asr:${cfg.engine}`, exe, [], (line) => asrLog(line));
    this.proc = proc;
    proc.on('exit', (code, signal) => {
      if (proc !== this.proc || this.stopping) return;
      log.warn(`ASR worker exited (code=${code} signal=${signal})`);
      this.setStatus('failed', () => t('asr.workerExited'));
      if (this.restarts < 5 && !this.restartTimer) {
        const delay = 1000 * 2 ** this.restarts++;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.stopping) this.start().catch((e) => log.error('Failed to restart ASR', e));
        }, delay);
      }
    });
    try {
      await proc.start(15000);
      this.setStatus('loading');
      const loaded = await proc.request('load', { modelPath: model.modelPath, language: this.language(), options: model.options }, 120000);
      const p = loaded.payload as { elapsedMs: number; model: string };
      this.modelDescription = p.model || model.description || '';
      log.info(`Loaded the ASR model (${this.modelDescription}, ${p.elapsedMs}ms)`);
      this.restarts = 0;
      this.setStatus('ready');
      // Warm up (so that recordings do not pay for the slow first inference)
      this.transcribe(new Float32Array(16000 * 0.5), { language: this.language(), hints: [], timeoutMs: 30000 }).catch(() => undefined);
    } catch (e) {
      log.error('Failed to start the ASR worker', e);
      const message = (e as Error).message;
      this.setStatus('failed', () => message);
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

  /** The queue is empty and no request is in progress */
  get idle(): boolean {
    return this.pending === 0;
  }

  /** Waits until ready (up to timeoutMs). True when ready */
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

  /** Transcribes audio. Requests are handled in order */
  transcribe(samples: Float32Array, opts: TranscribeOptions): Promise<AsrResultPayload> {
    const signal = opts.signal;
    const run = async () => {
      if (signal?.aborted) throw new AsrCancelledError();
      const proc = this.proc;
      if (!proc?.running || this.status !== 'ready') throw new Error(this.message || t('asr.notReady'));
      if (samples.length === 0) return { text: '', elapsedMs: 0 };
      // Tell the worker if canceled while in progress. A worker that does not support it finishes and returns the result
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
        // After a timeout the worker keeps working and would overlap the next request. Kill it so that it restarts (on exit)
        if ((e as { code?: string }).code === 'timeout' && proc === this.proc) {
          log.warn('ASR did not reply in time; restarting the worker');
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
   * Puts a request in the queue. The next request is not sent until the worker actually replies
   * (even after a cancel, the queue does not move on until the worker has finished)
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
