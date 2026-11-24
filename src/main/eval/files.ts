/**
 * 評価のファイルの読み書き。個人の書き起こしを含むので、フォルダは 0700、ファイルは 0600 で作る。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 評価のデータの置き場所（リポジトリの外）。LONGHAND_EVAL_ROOT で変えられる（テスト用） */
export function evalRoot(): string {
  return process.env.LONGHAND_EVAL_ROOT || path.join(os.homedir(), 'longhand-eval');
}

export function ensurePrivateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** 一時ファイルに書いてから置き換える（途中で止まっても壊れたファイルを残さない） */
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

/** キーの順をそろえた JSON（同じ中身なら同じ文字列になる）。undefined の項目は落とす */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/** ファイルの大きさと更新時刻（ビルドやモデルが変わったことを見分ける。コミットの代わり） */
export interface FileSig {
  size: number;
  mtimeMs: number;
}

/** ファイルなら大きさと更新時刻。フォルダなら、直下のファイルの大きさの合計と、最も新しい更新時刻。なければ null */
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
 * フォルダの中身のハッシュ（相対パスと内容。テストは除く）。
 * リポジトリにコミットが無いので、どの版のコードで測ったかの記録に使う
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
