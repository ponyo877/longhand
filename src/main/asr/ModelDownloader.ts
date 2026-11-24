/**
 * Downloads the speech recognition model (ASR-5).
 *
 * - The source is a Hugging Face URL pinned to a revision. To use a mirror, replace the source URL
 *   (same files and same hashes as asr/download-models.sh).
 * - Free space is checked before downloading, and only files whose SHA-256 matches are put in place.
 * - If the download is cut off, it retries after waiting 10 seconds, doubling each time. The part already received is resumed with Range.
 * - For offline computers, files downloaded on another computer can be imported instead (their hashes are checked the same way).
 *
 * It only goes online when the user presses the button. The only other connection is the LLM endpoint (OPS-1).
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelDownloadState } from '../../shared/types';
import { t } from '../i18n';
import { createLogger } from '../log';

const log = createLogger('model');

export interface ModelFile {
  /** Path relative to models/ */
  path: string;
  /** The part of the source URL after the base URL */
  urlPath: string;
  sha256: string;
  size: number;
}

/** The same files as the default of asr/download-models.sh (whisper large-v3-turbo q8_0 and Silero VAD) */
export const WHISPER_FILES: ModelFile[] = [
  {
    path: 'whisper/ggml-large-v3-turbo-q8_0.bin',
    urlPath: '/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q8_0.bin',
    sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1',
    size: 874188075,
  },
  {
    path: 'whisper/ggml-silero-v6.2.0.bin',
    urlPath: '/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin',
    sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
    size: 885098,
  },
];

/** Free space to leave after the download */
const SPARE_BYTES = 500 * 1024 * 1024;
const RETRY_FIRST_SEC = 10;
const MAX_ATTEMPTS = 6;

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface DownloaderDeps {
  modelsDir: string;
  fetch: FetchLike;
  /** Free space in bytes. Replaced in tests */
  freeBytes?: (dir: string) => number;
  /** Wait before a retry. Replaced in tests */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  files?: ModelFile[];
  /** Folder of the models bundled with the app. If every file is there, no download is needed */
  bundledDir?: string;
}

class Cancelled extends Error {}

function defaultFreeBytes(dir: string): number {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Cancelled());
    });
  });
}

async function hashFile(file: string, hash = createHash('sha256')): Promise<ReturnType<typeof createHash>> {
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash;
}

const sizeOf = (p: string) => {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
};

export class ModelDownloader extends EventEmitter {
  private st: ModelDownloadState = { state: 'idle', receivedBytes: 0, totalBytes: 0, installed: false };
  private abort: AbortController | null = null;
  private readonly files: ModelFile[];

  constructor(private readonly d: DownloaderDeps) {
    super();
    this.files = d.files ?? WHISPER_FILES;
    this.st.installed = this.installed();
    this.st.bundled = this.bundled() && !this.inDir(this.d.modelsDir);
  }

  get state(): ModelDownloadState {
    return this.st;
  }

  /** Whether every file is in place with the expected size (hashes were checked when the files were put in place) */
  installed(): boolean {
    return this.inDir(this.d.modelsDir) || this.bundled();
  }

  /** Whether every model file bundled with the app is there */
  bundled(): boolean {
    return !!this.d.bundledDir && this.inDir(this.d.bundledDir);
  }

  private inDir(dir: string): boolean {
    return this.files.every((f) => sizeOf(path.join(dir, f.path)) === f.size);
  }

  private set(patch: Partial<ModelDownloadState>): void {
    this.st = { ...this.st, ...patch };
    this.emit('change', this.st);
  }

  cancel(): void {
    this.abort?.abort();
  }

  /** Downloads. Does nothing if a download is already running. True on success */
  async download(baseUrl: string): Promise<boolean> {
    if (this.abort) return false;
    const abort = new AbortController();
    this.abort = abort;
    const base = baseUrl.replace(/\/+$/, '') || 'https://huggingface.co';
    const todo = this.files.filter((f) => sizeOf(path.join(this.d.modelsDir, f.path)) !== f.size);
    const total = todo.reduce((n, f) => n + f.size, 0);
    let done = 0;
    this.set({ state: 'downloading', receivedBytes: 0, totalBytes: total, error: undefined, retryInSec: undefined, file: undefined });
    try {
      fs.mkdirSync(this.d.modelsDir, { recursive: true });
      const already = todo.reduce((n, f) => n + Math.max(0, sizeOf(path.join(this.d.modelsDir, `${f.path}.part`))), 0);
      const free = (this.d.freeBytes ?? defaultFreeBytes)(this.d.modelsDir);
      if (free < total - already + SPARE_BYTES) {
        const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
        throw new Error(t('asr.download.noSpace', { needed: gb(total - already + SPARE_BYTES), free: gb(free) }));
      }
      for (const f of todo) {
        await this.fetchWithRetry(base, f, abort.signal, (n) => this.set({ receivedBytes: done + n, file: path.basename(f.path) }));
        done += f.size;
      }
      this.set({ state: 'done', receivedBytes: total, installed: this.installed(), file: undefined });
      log.info('Downloaded the model');
      return true;
    } catch (e) {
      if (e instanceof Cancelled || abort.signal.aborted) {
        this.set({ state: 'cancelled', retryInSec: undefined });
        log.info('Canceled the model download');
      } else {
        this.set({ state: 'failed', error: (e as Error).message, retryInSec: undefined });
        log.warn('Could not download the model', e);
      }
      return false;
    } finally {
      this.abort = null;
    }
  }

  private async fetchWithRetry(base: string, f: ModelFile, signal: AbortSignal, progress: (n: number) => void): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.fetchOne(base, f, signal, progress);
        return;
      } catch (e) {
        if (e instanceof Cancelled || signal.aborted) throw new Cancelled();
        if (attempt >= MAX_ATTEMPTS || (e as { fatal?: boolean }).fatal) throw e;
        const wait = RETRY_FIRST_SEC * 2 ** (attempt - 1);
        log.warn(`Model download failed. Retrying in ${wait} s (${attempt}/${MAX_ATTEMPTS})`, e);
        this.set({ state: 'waiting', retryInSec: wait, error: (e as Error).message });
        await (this.d.sleep ?? defaultSleep)(wait * 1000, signal);
        this.set({ state: 'downloading', retryInSec: undefined });
      }
    }
  }

  private async fetchOne(base: string, f: ModelFile, signal: AbortSignal, progress: (n: number) => void): Promise<void> {
    const dest = path.join(this.d.modelsDir, f.path);
    const part = `${dest}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let offset = Math.max(0, sizeOf(part));
    if (offset > f.size) {
      fs.rmSync(part, { force: true });
      offset = 0;
    }
    const headers: Record<string, string> = {};
    if (offset > 0 && offset < f.size) headers.Range = `bytes=${offset}-`;
    let hash = createHash('sha256');
    if (offset < f.size) {
      const res = await this.d.fetch(base + f.urlPath, { headers, signal });
      if (res.status === 416 && offset > 0) {
        // The part already received is broken. Start over
        fs.rmSync(part, { force: true });
        throw new Error(t('asr.download.resumeFailed'));
      }
      if (!res.ok || !res.body) {
        const err = new Error(t('asr.download.http', { status: res.status, url: base + f.urlPath })) as Error & { fatal?: boolean };
        // 404 and 403 do not get better by waiting
        err.fatal = res.status === 404 || res.status === 403 || res.status === 401;
        throw err;
      }
      if (res.status === 206) {
        hash = await hashFile(part, hash);
      } else {
        offset = 0;
      }
      const out = fs.createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' });
      let got = offset;
      progress(got);
      const reader = res.body.getReader();
      // Stop reading when canceled (while the body is being read, the fetch signal alone may not stop it)
      const onAbort = () => void reader.cancel().catch(() => undefined);
      signal.addEventListener('abort', onAbort);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          got += value.length;
          if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
          progress(got);
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        await new Promise<void>((r) => out.end(() => r()));
      }
      if (signal.aborted) throw new Cancelled();
      if (got !== f.size) throw new Error(t('asr.download.truncated', { got, size: f.size }));
    } else {
      hash = await hashFile(part, hash);
    }
    const sha = hash.digest('hex');
    if (sha !== f.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error(t('asr.download.hashMismatch', { file: path.basename(f.path) }));
    }
    fs.renameSync(part, dest);
    progress(f.size);
  }

  /**
   * Imports files downloaded on another computer (or folders that contain them). Files are matched by name and put in place after
   * their hashes are checked. Returns the names of the imported files.
   */
  async importFrom(sources: string[]): Promise<{ imported: string[]; rejected: string[] }> {
    const candidates: string[] = [];
    for (const src of sources) {
      if (fs.statSync(src).isDirectory()) {
        for (const f of this.files) {
          for (const p of [path.join(src, path.basename(f.path)), path.join(src, f.path)]) if (fs.existsSync(p)) candidates.push(p);
        }
      } else {
        candidates.push(src);
      }
    }
    const imported: string[] = [];
    const rejected: string[] = [];
    for (const src of candidates) {
      const f = this.files.find((x) => path.basename(x.path) === path.basename(src));
      if (!f || imported.includes(path.basename(src))) continue;
      const sha = (await hashFile(src)).digest('hex');
      if (sha !== f.sha256) {
        rejected.push(path.basename(src));
        continue;
      }
      const dest = path.join(this.d.modelsDir, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (path.resolve(src) !== path.resolve(dest)) {
        fs.copyFileSync(src, `${dest}.part`);
        fs.renameSync(`${dest}.part`, dest);
      }
      imported.push(path.basename(src));
    }
    for (const src of sources) {
      const name = path.basename(src);
      if (!fs.statSync(src).isDirectory() && !this.files.some((f) => path.basename(f.path) === name) && !rejected.includes(name)) rejected.push(name);
    }
    this.set({ installed: this.installed(), ...(this.installed() ? { state: 'done' as const } : {}) });
    return { imported, rejected };
  }
}
