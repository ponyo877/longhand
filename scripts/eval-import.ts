/**
 * 評価に使う録音を、消える前に ~/longhand-eval/datasets/ に写す。
 *
 *   npx tsx scripts/eval-import.ts            # 取り込む
 *   npx tsx scripts/eval-import.ts --dry-run  # 件数だけを見る
 *
 * 写すもの:
 * - longhand-v1: Longhand の履歴と録音（手元のファイルを読むだけで、通信はしない）
 *
 * Longhand は録音を 72 時間で消すので、評価に使いたい録音は、消える前に走らせて写しておく。何度走らせても、増えた分だけを足す。
 * 個人の書き起こしを含むので、出力先はリポジトリの外に固定し、画面には件数だけを出す。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { decodeWav } from '../src/main/audio/wav';

const { values: args } = parseArgs({
  options: {
    root: { type: 'string', default: path.join(os.homedir(), 'longhand-eval') },
    'dry-run': { type: 'boolean', default: false },
  },
});

const ROOT = args.root!;
const DATASETS = path.join(ROOT, 'datasets');
const LONGHAND_APP = path.join(os.homedir(), 'Library', 'Application Support', 'Longhand');
const DRY = args['dry-run']!;

/** データセットの 1 行。最初の取り込みの形（id, audio, durationSec, timestamp, kind, rawText, content）に項目を足したもの */
interface Row {
  id: string;
  /** データセットのフォルダからの相対パス */
  audio: string;
  durationSec: number;
  timestamp: string;
  kind: string;
  /** そのアプリの音声認識の生の出力 */
  rawText: string;
  /** そのアプリが入力した文（整形の後） */
  content: string;
  /** external は、ほかの道具で用意した録音（手で置いたデータセット） */
  source: 'external' | 'longhand';
  audioSha256: string;
  sampleRate: number;
  importedAt: string;
  /** Longhand の録音だけ: 入力先のアプリ、貼り付けの結果、整形したか */
  app?: string;
  paste?: string;
  formatted?: boolean;
  fastPath?: boolean;
  /** Longhand の録音だけ: キーを離した後も録音を続けた時間（録音の末尾のこの長さが、離した後の音声） */
  postRollMs?: number;
  /** Longhand の録音だけ: 入力先の画面の文から拾えた、名前らしい英字の語 */
  contextTerms?: string[];
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

function readRows(dir: string): Row[] {
  const file = path.join(dir, 'manifest.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row);
}

/** すでに取り込んだ発話の id と、音声の中身のハッシュ */
function known(): { ids: Set<string>; hashes: Set<string> } {
  const ids = new Set<string>();
  const hashes = new Set<string>();
  if (!fs.existsSync(DATASETS)) return { ids, hashes };
  for (const name of fs.readdirSync(DATASETS)) {
    const dir = path.join(DATASETS, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const row of readRows(dir)) {
      ids.add(row.id);
      if (row.audioSha256) hashes.add(row.audioSha256);
      else {
        // 最初の取り込みにはハッシュが無いので、音声から求める
        const file = path.join(dir, row.audio);
        if (fs.existsSync(file)) hashes.add(sha256(fs.readFileSync(file)));
      }
    }
  }
  return { ids, hashes };
}

interface Candidate {
  id: string;
  file: string;
  timestamp: string;
  kind: string;
  rawText: string;
  content: string;
  durationSec?: number;
  extra?: Partial<Row>;
}

interface Counts {
  found: number;
  added: number;
  already: number;
  noAudio: number;
  duplicate: number;
  unreadable: number;
  otherRate: number;
}

function importInto(name: string, source: Row['source'], cands: Candidate[], seen: ReturnType<typeof known>): Counts {
  const c: Counts = { found: cands.length, added: 0, already: 0, noAudio: 0, duplicate: 0, unreadable: 0, otherRate: 0 };
  const dir = path.join(DATASETS, name);
  const audioDir = path.join(dir, 'audio');
  const lines: string[] = [];
  for (const cand of cands) {
    if (seen.ids.has(cand.id)) {
      c.already++;
      continue;
    }
    if (!fs.existsSync(cand.file)) {
      c.noAudio++;
      continue;
    }
    const buf = fs.readFileSync(cand.file);
    const hash = sha256(buf);
    if (seen.hashes.has(hash)) {
      c.duplicate++;
      continue;
    }
    let sampleRate: number;
    let seconds: number;
    try {
      const wav = decodeWav(buf);
      sampleRate = wav.sampleRate;
      seconds = wav.samples.length / wav.sampleRate;
    } catch {
      c.unreadable++;
      continue;
    }
    if (sampleRate !== 16000) c.otherRate++;
    const row: Row = {
      id: cand.id,
      audio: `audio/${cand.id}.wav`,
      durationSec: Math.round((cand.durationSec ?? seconds) * 10) / 10,
      timestamp: cand.timestamp,
      kind: cand.kind,
      rawText: cand.rawText,
      content: cand.content,
      source,
      audioSha256: hash,
      sampleRate,
      importedAt: new Date().toISOString(),
      ...cand.extra,
    };
    if (!DRY) {
      fs.mkdirSync(audioDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(audioDir, `${cand.id}.wav`), buf, { mode: 0o600 });
    }
    lines.push(JSON.stringify(row));
    seen.ids.add(cand.id);
    seen.hashes.add(hash);
    c.added++;
  }
  if (lines.length && !DRY) fs.appendFileSync(path.join(dir, 'manifest.jsonl'), `${lines.join('\n')}\n`, { mode: 0o600 });
  return c;
}

/** Longhand の履歴と録音 */
function longhandCandidates(): Candidate[] {
  const file = path.join(LONGHAND_APP, 'history.json');
  if (!fs.existsSync(file)) return [];
  let items: Record<string, unknown>[];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { items?: Record<string, unknown>[] } | Record<string, unknown>[];
    items = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const it of items) {
    const audioFile = typeof it.audioFile === 'string' ? it.audioFile : '';
    if (!audioFile) continue;
    const app = it.app as { bundleId?: string } | undefined;
    out.push({
      id: `longhand_${path.basename(audioFile, '.wav')}`,
      file: path.join(LONGHAND_APP, 'recordings', path.basename(audioFile)),
      timestamp: new Date(Number(it.timestamp ?? 0)).toISOString(),
      kind: String(it.mode ?? 'dictation'),
      rawText: String(it.rawText ?? ''),
      content: String(it.text ?? ''),
      durationSec: typeof it.durationSec === 'number' ? it.durationSec : undefined,
      extra: {
        app: app?.bundleId,
        paste: typeof it.paste === 'string' ? it.paste : undefined,
        formatted: typeof it.formatted === 'boolean' ? it.formatted : undefined,
        fastPath: it.fastPath === true ? true : undefined,
        contextTerms: Array.isArray(it.contextTerms) ? (it.contextTerms as unknown[]).filter((t): t is string => typeof t === 'string') : undefined,
        postRollMs: typeof (it.timings as { postRollMs?: unknown } | undefined)?.postRollMs === 'number' ? (it.timings as { postRollMs: number }).postRollMs : undefined,
      },
    });
  }
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function main(): void {
  if (!DRY) fs.mkdirSync(DATASETS, { recursive: true, mode: 0o700 });
  const seen = known();

  const report = (name: string, c: Counts) =>
    console.log(
      `${name}: 履歴 ${c.found} 件 → 追加 ${c.added} 件（取り込み済み ${c.already}、音声なし ${c.noAudio}、同じ音声 ${c.duplicate}、読めない ${c.unreadable}）` +
        (c.otherRate ? `、16 kHz 以外 ${c.otherRate} 件` : ''),
    );
  report('longhand-v1', importInto('longhand-v1', 'longhand', longhandCandidates(), seen));

  if (!DRY) {
    for (const name of fs.readdirSync(DATASETS).sort()) {
      const dir = path.join(DATASETS, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const rows = readRows(dir);
      const withText = rows.filter((r) => r.content.trim()).length;
      console.log(`  ${name}: ${rows.length} 件（文あり ${withText} 件、合計 ${Math.round(rows.reduce((n, r) => n + r.durationSec, 0))} 秒）`);
    }
  } else console.log('（--dry-run: 何も書いていません）');
}

main();
