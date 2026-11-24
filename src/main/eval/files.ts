/**
 * Reading and writing evaluation files. They hold personal transcripts, so folders are created 0700 and files 0600.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where the evaluation data lives (outside the repository). LONGHAND_EVAL_ROOT changes it (for tests) */
export function evalRoot(): string {
  return process.env.LONGHAND_EVAL_ROOT || path.join(os.homedir(), 'longhand-eval');
}

export function ensurePrivateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Writes to a temporary file and then replaces the file (stopping halfway never leaves a broken file) */
export function writePrivate(file: string, data: string): void {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function appendPrivate(file: string, data: string): void {
  ensurePrivateDir(path.dirname(file));
  fs.appendFileSync(file, data, { mode: 0o600 });
}

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON with sorted keys (the same content gives the same string). Drops undefined fields */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/** Size and modification time of a file (tells that a build or a model changed, in place of a commit) */
export interface FileSig {
  size: number;
  mtimeMs: number;
}

/** For a file, its size and modification time. For a folder, the total size of the files directly in it and the latest modification time. null if missing */
export function fileSig(p: string): FileSig | null {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    let size = 0;
    let mtimeMs = 0;
    for (const name of fs.readdirSync(p).sort()) {
      const s = fs.statSync(path.join(p, name));
      if (!s.isFile()) continue;
      size += s.size;
      mtimeMs = Math.max(mtimeMs, s.mtimeMs);
    }
    return { size, mtimeMs: Math.round(mtimeMs) };
  } catch {
    return null;
  }
}

/**
 * Hash of a folder's contents (relative paths and contents, excluding tests).
 * The repository has no commits, so this records which version of the code was measured
 */
export function hashTree(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && !/\.test\.tsx?$/.test(name)) {
        h.update(path.relative(dir, p));
        h.update('\0');
        h.update(fs.readFileSync(p));
        h.update('\0');
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return h.digest('hex');
}
