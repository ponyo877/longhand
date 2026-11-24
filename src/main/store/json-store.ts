import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads and writes a JSON file. Writes go to a temporary file that is then renamed, so a crash midway never corrupts the file.
 * Writes are debounced and batched.
 */
export class JsonStore<T> {
  private timer: NodeJS.Timeout | null = null;
  private pending: T | null = null;

  constructor(
    private readonly file: string,
    private readonly debounceMs = 200,
    /** readOnly only reads: writes are dropped, and a corrupt file is not moved aside */
    private readonly opts: { readOnly?: boolean } = {},
  ) {}

  read(): unknown {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && !this.opts.readOnly) {
        // Move a corrupt file aside and start from the defaults
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
