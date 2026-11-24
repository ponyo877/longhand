/**
 * Copies recordings used for evaluation into ~/longhand-eval/datasets/ before they are deleted.
 *
 *   npx tsx scripts/eval-import.ts            # import
 *   npx tsx scripts/eval-import.ts --dry-run  # show counts only
 *
 * What it copies:
 * - longhand-v1: Longhand's history and recordings (it only reads local files, no network)
 *
 * Longhand deletes recordings after 72 hours, so run this before then to copy the recordings you want for evaluation. Each run adds only
 * what is new.
 * The data contains personal transcripts, so the output stays outside the repository and only counts are printed.
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

/** One dataset row: the shape of the first import (id, audio, durationSec, timestamp, kind, rawText, content) plus more fields */
interface Row {
  id: string;
  /** Path relative to the dataset folder */
  audio: string;
  durationSec: number;
  timestamp: string;
  kind: string;
  /** Raw speech recognition output of that app */
  rawText: string;
  /** Text that app typed (after formatting) */
  content: string;
  /** external means recordings prepared with other tools (a dataset placed by hand) */
  source: 'external' | 'longhand';
  audioSha256: string;
  sampleRate: number;
  importedAt: string;
  /** Longhand recordings only: the target app, the paste result, and whether it was formatted */
  app?: string;
  paste?: string;
  formatted?: boolean;
  fastPath?: boolean;
  /** Longhand recordings only: how long recording continued after the key was released (this much at the end is audio after release) */
  postRollMs?: number;
  /** Longhand recordings only: Latin-letter words that look like names, picked from the text on the target screen */
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

/** IDs of utterances already imported, and hashes of their audio content */
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
        // The first import has no hash, so compute it from the audio
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

/** Longhand's history and recordings */
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
      `${name}: ${c.found} in history → ${c.added} added (${c.already} already imported, ${c.noAudio} without audio, ${c.duplicate} duplicate audio, ${c.unreadable} unreadable)` +
        (c.otherRate ? `, ${c.otherRate} not 16 kHz` : ''),
    );
  report('longhand-v1', importInto('longhand-v1', 'longhand', longhandCandidates(), seen));

  if (!DRY) {
    for (const name of fs.readdirSync(DATASETS).sort()) {
      const dir = path.join(DATASETS, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const rows = readRows(dir);
      const withText = rows.filter((r) => r.content.trim()).length;
      console.log(`  ${name}: ${rows.length} rows (${withText} with text, ${Math.round(rows.reduce((n, r) => n + r.durationSec, 0))} s in total)`);
    }
  } else console.log('(--dry-run: nothing was written)');
}

main();
