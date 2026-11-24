/**
 * Loading evaluation datasets and references.
 *
 * - Dataset: <root>/datasets/<name>/manifest.jsonl and audio/ (created by scripts/eval-import.ts)
 * - References: <root>/truth.jsonl. Append-only; for the same id, the last line wins
 * - An utterance without a reference yet uses the manifest's content (the text that app entered) as a provisional reference, marked as provisional
 * - Dev and holdout split: scripted readings follow the row's split (A is dev, B is holdout).
 *   Natural utterances are sorted by time and start a new chunk after a gap of 3 minutes or more. Chunks go, in time order, to whichever side has fewer items at that point (dev on a tie).
 *   Utterances spoken in a row have similar content, so assigning each utterance on its own would mix near-copies of dev sentences into holdout. That is why chunks are never split.
 *   Utterances without a time (public data) are assigned by a hash of the sentence number (or the id when there is none). Recordings of the same sentence by different people land on the same side
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, sha256Hex } from './files';

/** One line of manifest.jsonl (Row in scripts/eval-import.ts. The first import has no fields from source on) */
export interface ManifestRow {
  id: string;
  /** Path relative to the dataset folder */
  audio: string;
  durationSec: number;
  timestamp: string;
  kind: string;
  rawText: string;
  content: string;
  source?: string;
  audioSha256?: string;
  sampleRate?: number;
  /** Scripted readings only: A is dev, B is holdout */
  split?: 'A' | 'B';
  tags?: string[];
  /** Scripted readings only: terms that appear in the sentence */
  terms?: string[];
  /** Public data only: number of the sentence read aloud (several people read the same sentence) */
  sentenceId?: string;
  /** Scripted readings only: kind of sentence (lexicon, unlisted, number, homophone, particle, short, long, mixed) */
  category?: string;
  /** Length recorded after the key was released (ms). Only for recordings made since recording continues after release */
  postRollMs?: number;
}

/** One line of truth.jsonl */
export interface TruthRow {
  id: string;
  audioSha256: string;
  /** The text that should be entered */
  target: string;
  /** The text as spoken (same as target when absent) */
  spoken?: string;
  /** Alternative spellings */
  alt?: string[];
  tags?: string[];
  status: 'ok' | 'excluded';
  prefill: 'external' | 'longhand' | 'script' | 'public';
  reviewedAt: string;
}

export type Split = 'dev' | 'holdout';

/** One utterance to evaluate */
export interface Utterance {
  id: string;
  dataset: string;
  audioPath: string;
  audioSha256: string;
  durationSec: number;
  /** Time of recording (ms since the epoch). 0 when unknown */
  timestamp: number;
  split: Split;
  /** Number of the natural-utterance chunk (from 0 within the dataset). -1 for scripted readings and for utterances without a time */
  chunk: number;
  target: string;
  spoken: string;
  alt: string[];
  tags: string[];
  terms: string[];
  /** Kind of scripted sentence. undefined for datasets without it */
  category?: string;
  /** Length recorded after the key was released (ms). undefined when unknown */
  postRollMs?: number;
  /** Whether the reference is provisional (not checked by a person; the manifest's content was used) */
  provisional: boolean;
}

export interface DatasetCounts {
  rows: number;
  used: number;
  /** Utterances with a provisional reference (out of used) */
  provisional: number;
  /** Utterances with a reference checked by a person (out of used) */
  reviewed: number;
  /** Utterances excluded by their reference */
  excluded: number;
  /** Utterances with neither a reference nor content */
  noReference: number;
  /** Utterances whose reference has a different audio hash (fell back to the provisional reference) */
  hashMismatch: number;
  missingAudio: number;
}

/** Gap after which natural utterances count as a separate chunk */
export const CHUNK_GAP_MS = 3 * 60 * 1000;

function parseTime(timestamp: string): number {
  const t = Date.parse(timestamp);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Splits utterances into dev and holdout. Pass every row of the dataset (including rows that are not used, so that chunks do not depend on which rows have references).
 *
 * Natural utterances form chunks in time order, and each chunk goes to whichever side has fewer items at that point (dev on a tie). Chunks are never split.
 * Only rows with text (non-empty content) are counted. Rows without text, such as cancelled recordings, belong to a chunk but are not counted.
 * When rows are added later, the assignment of earlier rows does not change as long as the new times come after them
 */
export function assignSplits(
  rows: readonly (Pick<ManifestRow, 'id' | 'timestamp' | 'split' | 'sentenceId'> & { content?: string })[],
  gapMs = CHUNK_GAP_MS,
): Map<string, { split: Split; chunk: number }> {
  const out = new Map<string, { split: Split; chunk: number }>();
  const natural: { id: string; t: number; counted: boolean }[] = [];
  for (const r of rows) {
    const t = parseTime(r.timestamp);
    if (r.split === 'A' || r.split === 'B') out.set(r.id, { split: r.split === 'A' ? 'dev' : 'holdout', chunk: -1 });
    else if (!t) {
      // Chunks cannot be formed without a time. Assign by the parity of a hash of the sentence number (or the id when there is none)
      const even = parseInt(sha256Hex(r.sentenceId || r.id).slice(0, 8), 16) % 2 === 0;
      out.set(r.id, { split: even ? 'dev' : 'holdout', chunk: -1 });
    } else natural.push({ id: r.id, t, counted: r.content === undefined || !!r.content.trim() });
  }
  natural.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const chunks: { ids: string[]; counted: number }[] = [];
  natural.forEach((r, i) => {
    if (i === 0 || r.t - natural[i - 1].t >= gapMs) chunks.push({ ids: [], counted: 0 });
    const c = chunks[chunks.length - 1];
    c.ids.push(r.id);
    if (r.counted) c.counted++;
  });
  const total: Record<Split, number> = { dev: 0, holdout: 0 };
  chunks.forEach((c, chunk) => {
    const split: Split = total.holdout < total.dev ? 'holdout' : 'dev';
    total[split] += c.counted;
    for (const id of c.ids) out.set(id, { split, chunk });
  });
  return out;
}

/** Reads the references. For the same id, the last line wins. Empty when the file does not exist */
export function loadTruth(file: string): Map<string, TruthRow> {
  const out = new Map<string, TruthRow>();
  for (const row of readJsonl<TruthRow>(file)) {
    if (row && typeof row.id === 'string' && (row.status === 'ok' || row.status === 'excluded')) out.set(row.id, row);
  }
  return out;
}

export function readManifest(dir: string): ManifestRow[] {
  return readJsonl<ManifestRow>(path.join(dir, 'manifest.jsonl')).filter((r) => r && typeof r.id === 'string' && typeof r.audio === 'string');
}

export interface LoadedDataset {
  name: string;
  utterances: Utterance[];
  counts: DatasetCounts;
}

/** Reads a dataset and matches it with the references into a list of utterances to evaluate (in time order) */
export function loadDataset(root: string, name: string, truth: ReadonlyMap<string, TruthRow>): LoadedDataset {
  const dir = path.join(root, 'datasets', name);
  if (!fs.existsSync(path.join(dir, 'manifest.jsonl'))) throw new Error(`Dataset not found: ${dir}`);
  const rows = readManifest(dir);
  const splits = assignSplits(rows);
  const counts: DatasetCounts = { rows: rows.length, used: 0, provisional: 0, reviewed: 0, excluded: 0, noReference: 0, hashMismatch: 0, missingAudio: 0 };
  const utterances: Utterance[] = [];
  for (const row of rows) {
    const audioPath = path.join(dir, row.audio);
    if (!fs.existsSync(audioPath)) {
      counts.missingAudio++;
      continue;
    }
    // Rows from the first import have no hash, so compute it from the audio
    const audioSha256 = row.audioSha256 || sha256Hex(fs.readFileSync(audioPath));
    let t = truth.get(row.id);
    if (t?.status === 'excluded') {
      counts.excluded++;
      continue;
    }
    if (t && t.audioSha256 && t.audioSha256 !== audioSha256) {
      // Do not use a reference made for different audio
      counts.hashMismatch++;
      t = undefined;
    }
    const content = (row.content ?? '').trim();
    if (!t && !content) {
      counts.noReference++;
      continue;
    }
    const s = splits.get(row.id)!;
    const target = t ? t.target : content;
    utterances.push({
      id: row.id,
      dataset: name,
      audioPath,
      audioSha256,
      durationSec: row.durationSec,
      timestamp: parseTime(row.timestamp),
      split: s.split,
      chunk: s.chunk,
      target,
      spoken: t?.spoken?.trim() ? t.spoken : target,
      alt: (t?.alt ?? []).filter((a) => typeof a === 'string' && a.trim()),
      tags: [...new Set([...(row.tags ?? []), ...(t?.tags ?? [])])],
      terms: row.terms ?? [],
      category: typeof row.category === 'string' && row.category ? row.category : undefined,
      postRollMs: typeof row.postRollMs === 'number' && row.postRollMs > 0 ? row.postRollMs : undefined,
      provisional: !t,
    });
    counts.used++;
    if (t) counts.reviewed++;
    else counts.provisional++;
  }
  utterances.sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { name, utterances, counts };
}

/** Reads a file with one word per line (dictionary words, the same format as the existing --vocab). Drops empty lines and duplicates */
export function readWordList(file: string): string[] {
  return [
    ...new Set(
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((w) => w.trim())
        .filter(Boolean),
    ),
  ];
}
