/**
 * 音声認識のモデルの取得（ASR-5）。
 *
 * - 取得元は Hugging Face のリビジョンを固定した URL。ミラーを使う場合は取得元の URL を差し替える
 *   （asr/download-models.sh と同じファイル、同じハッシュ）。
 * - 空き容量を確かめてから取得し、SHA-256 が一致したものだけを置く。
 * - 途中で切れたら、10 秒から倍々で待って再試行する。取得済みの分は Range で続きから取る。
 * - オフラインの PC 向けに、別の PC で取得したファイルを取り込むこともできる（ハッシュは同じく確かめる）。
 *
 * 利用者がボタンを押したときだけ通信する。ほかの通信は LLM の接続先だけである（OPS-1）。
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelDownloadState } from '../../shared/types';
import { createLogger } from '../log';

const log = createLogger('model');

export interface ModelFile {
  /** models/ からの相対パス */
  path: string;
  /** 取得元の URL のうち、ベース URL より後ろ */
  urlPath: string;
  sha256: string;
  size: number;
}

/** asr/download-models.sh の既定（whisper large-v3-turbo q8_0 と Silero VAD）と同じもの */
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

/** 取得後に残しておきたい空き容量 */
const SPARE_BYTES = 500 * 1024 * 1024;
const RETRY_FIRST_SEC = 10;
const MAX_ATTEMPTS = 6;

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface DownloaderDeps {
  modelsDir: string;
  fetch: FetchLike;
  /** 空き容量（バイト）。テストで差し替える */
  freeBytes?: (dir: string) => number;
  /** 再試行までの待ち。テストで差し替える */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  files?: ModelFile[];
  /** アプリに同梱したモデルのフォルダ。ここにそろっていれば、取得は要らない */
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

  /** すべてのファイルが、期待した大きさで置かれているか（ハッシュは置くときに確かめている） */
  installed(): boolean {
    return this.inDir(this.d.modelsDir) || this.bundled();
  }

  /** アプリに同梱されたモデルがそろっているか */
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

  /** 取得する。すでに走っていれば何もしない。成功したら true */
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
        throw new Error(`空き容量が足りません（必要 ${gb(total - already + SPARE_BYTES)} GB、空き ${gb(free)} GB）`);
      }
      for (const f of todo) {
        await this.fetchWithRetry(base, f, abort.signal, (n) => this.set({ receivedBytes: done + n, file: path.basename(f.path) }));
        done += f.size;
      }
      this.set({ state: 'done', receivedBytes: total, installed: this.installed(), file: undefined });
      log.info('モデルを取得しました');
      return true;
    } catch (e) {
      if (e instanceof Cancelled || abort.signal.aborted) {
        this.set({ state: 'cancelled', retryInSec: undefined });
        log.info('モデルの取得を取り消しました');
      } else {
        this.set({ state: 'failed', error: (e as Error).message, retryInSec: undefined });
        log.warn('モデルを取得できませんでした', e);
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
        log.warn(`モデルの取得に失敗しました。${wait} 秒後に再試行します（${attempt}/${MAX_ATTEMPTS}）`, e);
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
        // 取得済みの部分がおかしい。最初から取り直す
        fs.rmSync(part, { force: true });
        throw new Error('途中まで取得したファイルを再開できませんでした');
      }
      if (!res.ok || !res.body) {
        const err = new Error(`HTTP ${res.status}（${base + f.urlPath}）`) as Error & { fatal?: boolean };
        // 404 や 403 は待っても直らない
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
      // 取り消したら読み取りを打ち切る（本文の読み取り中は fetch の signal だけでは止まらないことがある）
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
      if (got !== f.size) throw new Error(`途中で切れました（${got}/${f.size} バイト）`);
    } else {
      hash = await hashFile(part, hash);
    }
    const sha = hash.digest('hex');
    if (sha !== f.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error(`SHA-256 が一致しません: ${path.basename(f.path)}`);
    }
    fs.renameSync(part, dest);
    progress(f.size);
  }

  /**
   * 別の PC で取得したファイル（またはそれを含むフォルダ）を取り込む。名前で照合し、ハッシュを確かめてから置く。
   * 返り値は取り込んだファイル名。
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
