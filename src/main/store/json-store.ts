import fs from 'node:fs';
import path from 'node:path';

/**
 * JSON ファイルの読み書き。書き込みは一時ファイルに書いてから rename するので、途中で落ちても壊れない。
 * 書き込みは debounce してまとめる。
 */
export class JsonStore<T> {
  private timer: NodeJS.Timeout | null = null;
  private pending: T | null = null;

  constructor(
    private readonly file: string,
    private readonly debounceMs = 200,
    /** readOnly なら読むだけにする。書き込みは捨て、壊れたファイルも退避しない */
    private readonly opts: { readOnly?: boolean } = {},
  ) {}

  read(): unknown {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && !this.opts.readOnly) {
        // 壊れたファイルは退避して既定値で始める
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          /* ignore */
        }
      }
      return undefined;
    }
  }

  write(value: T): void {
    if (this.opts.readOnly) return;
    this.pending = value;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending === null) return;
    const data = JSON.stringify(this.pending, null, 2);
    this.pending = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
