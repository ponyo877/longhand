import fs from 'node:fs';
import path from 'node:path';
import { encodeWav } from '../audio/wav';
import { createLogger } from '../log';

const log = createLogger('recordings');

/** 録音の保存と掃除（REC-6）。既定で 72 時間、合計 300MB まで残し、2 時間ごとに掃除する */
export class RecordingStore {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dir: string,
    private readonly limits: () => { hours: number; maxMB: number },
  ) {}

  start(): void {
    this.cleanup();
    this.timer = setInterval(() => this.cleanup(), 2 * 60 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  save(samples: Float32Array, ts: number): string {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const name = `rec_${ts}.wav`;
    fs.writeFileSync(path.join(this.dir, name), encodeWav(samples), { mode: 0o600 });
    return name;
  }

  pathOf(name: string): string {
    return path.join(this.dir, path.basename(name));
  }

  read(name: string): Buffer | null {
    try {
      return fs.readFileSync(this.pathOf(name));
    } catch {
      return null;
    }
  }

  remove(name: string | undefined): void {
    if (!name) return;
    fs.rm(this.pathOf(name), { force: true }, () => undefined);
  }

  cleanup(): void {
    try {
      if (!fs.existsSync(this.dir)) return;
      const { hours, maxMB } = this.limits();
      const now = Date.now();
      const files = fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.wav'))
        .map((f) => {
          const st = fs.statSync(path.join(this.dir, f));
          return { f, mtime: st.mtimeMs, size: st.size };
        })
        .sort((a, b) => b.mtime - a.mtime);
      let total = 0;
      let removed = 0;
      for (const x of files) {
        total += x.size;
        if (now - x.mtime > hours * 3600_000 || total > maxMB * 1024 * 1024) {
          fs.rmSync(path.join(this.dir, x.f), { force: true });
          removed++;
        }
      }
      if (removed) log.info(`録音を ${removed} 件削除しました`);
    } catch (e) {
      log.warn('録音の掃除に失敗しました', e);
    }
  }
}
