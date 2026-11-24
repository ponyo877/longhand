/**
 * A local-only review page for building evaluation references.
 *
 *   npx tsx scripts/review/server.ts          # start and print the URL
 *   npx tsx scripts/review/server.ts --open   # open in the default browser
 *
 * What it does:
 * - Reference review: listen to imported recordings (~/longhand-eval/datasets/), confirm the text that should be typed, and append it
 *   to ~/longhand-eval/truth.jsonl
 * - Script reading: the user dictates the sentences in scripts/review/script-v1.json with Longhand, and the recordings are imported as
 *   script-v1
 *
 * It handles personal transcripts, so it listens on 127.0.0.1 only and rejects requests whose URL token does not match.
 * The page stores nothing (references go to an append-only file, so you can stop at any point and resume later).
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { decodeWav } from '../../src/main/audio/wav';

const { values: args } = parseArgs({
  options: {
    root: { type: 'string', default: path.join(os.homedir(), 'longhand-eval') },
    longhand: { type: 'string', default: path.join(os.homedir(), 'Library', 'Application Support', 'Longhand') },
    port: { type: 'string', default: '0' },
    open: { type: 'boolean', default: false },
    // Pass the previous token to keep the same URL after a restart
    token: { type: 'string', default: '' },
  },
});

const ROOT = args.root!;
const DATASETS = path.join(ROOT, 'datasets');
const TRUTH = path.join(ROOT, 'truth.jsonl');
const LONGHAND_APP = args.longhand!;
const HERE = path.join(process.cwd(), 'scripts', 'review');
const SCRIPT_FILE = path.join(HERE, 'script-v1.json');
const SCRIPT_DATASET = 'script-v1';
/** Datasets to review (the script is excluded: the sentence read aloud is the reference) */
const REVIEW_DATASETS = ['user-v1', 'user-v2', 'longhand-v1'];
const TOKEN = /^[0-9a-f]{24,}$/.test(args.token!) ? args.token! : randomBytes(18).toString('hex');

interface Row {
  id: string;
  audio: string;
  durationSec: number;
  timestamp: string;
  kind?: string;
  rawText: string;
  content: string;
  source?: string;
  audioSha256?: string;
  paste?: string;
  [key: string]: unknown;
}

interface Truth {
  id: string;
  audioSha256: string;
  /** Text that should be typed */
  target: string;
  /** Text as spoken (only for utterances with self-corrections or fillers) */
  spoken?: string;
  /** Alternatives that differ in notation */
  alt?: string[];
  tags?: string[];
  status: 'ok' | 'excluded';
  prefill: 'external' | 'longhand' | 'script';
  reviewedAt: string;
}

interface ScriptItem {
  id: string;
  split: 'A' | 'B';
  category: string;
  text: string;
  terms: string[];
  tags?: string[];
  instruction?: string;
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function readRows(dataset: string): Row[] {
  return readJsonl<Row>(path.join(DATASETS, dataset, 'manifest.jsonl'));
}

/** The last line for an id wins */
function readTruth(): Map<string, Truth> {
  const map = new Map<string, Truth>();
  for (const t of readJsonl<Truth>(TRUTH)) map.set(t.id, t);
  return map;
}

function findRow(id: string): { dataset: string; row: Row } | null {
  for (const dataset of [...REVIEW_DATASETS, SCRIPT_DATASET]) {
    const row = readRows(dataset).find((r) => r.id === id);
    if (row) return { dataset, row };
  }
  return null;
}

function audioPath(dataset: string, row: Row): string {
  return path.join(DATASETS, dataset, row.audio);
}

function appendTruth(t: Truth): void {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  fs.appendFileSync(TRUTH, `${JSON.stringify(t)}\n`, { mode: 0o600 });
}

function readScript(): { categories: Record<string, string>; items: ScriptItem[] } {
  return JSON.parse(fs.readFileSync(SCRIPT_FILE, 'utf8')) as { categories: Record<string, string>; items: ScriptItem[] };
}

// ---------------------------------------------------------------------------
// Importing script recordings
// ---------------------------------------------------------------------------

interface LonghandHistoryItem {
  timestamp: number;
  text: string;
  rawText: string;
  audioFile?: string;
  durationSec: number;
  paste: string;
  mode: string;
  timings?: { postRollMs?: number };
}

function longhandHistory(): LonghandHistoryItem[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(LONGHAND_APP, 'history.json'), 'utf8')) as { items?: LonghandHistoryItem[] } | LonghandHistoryItem[];
    return Array.isArray(parsed) ? parsed : (parsed.items ?? []);
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Imports the newest Longhand recording that started after since as the recording of the script sentence.
 * The history is written with a short delay, so it waits until one is found.
 */
async function captureScript(item: ScriptItem, since: number): Promise<{ ok: true; durationSec: number } | { ok: false; reason: string }> {
  let found: LonghandHistoryItem | undefined;
  for (let i = 0; i < 40 && !found; i++) {
    found = longhandHistory()
      .filter((h) => h.timestamp >= since - 1500 && h.audioFile && h.paste !== 'cancelled' && h.mode === 'dictation')
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    if (!found) await sleep(250);
  }
  if (!found?.audioFile) return { ok: false, reason: 'No recording of this sentence was found in Longhand’s history. Check that you dictated it with Longhand, then read it again.' };
  const src = path.join(LONGHAND_APP, 'recordings', path.basename(found.audioFile));
  if (!fs.existsSync(src)) return { ok: false, reason: 'The recording file was not found. Check that “Save recordings” is on in Longhand’s settings.' };
  const buf = fs.readFileSync(src);
  const wav = decodeWav(buf);
  const dir = path.join(DATASETS, SCRIPT_DATASET);
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'audio', `${item.id}.wav`), buf, { mode: 0o600 });
  const hash = sha256(buf);
  const row: Row = {
    id: item.id,
    audio: `audio/${item.id}.wav`,
    durationSec: Math.round((wav.samples.length / wav.sampleRate) * 10) / 10,
    timestamp: new Date(found.timestamp).toISOString(),
    kind: 'dictation',
    // Longhand's output at recording time (for reference; the reference text is the script sentence)
    rawText: found.rawText,
    longhandText: found.text,
    content: item.text,
    source: 'script',
    audioSha256: hash,
    sampleRate: wav.sampleRate,
    importedAt: new Date().toISOString(),
    // How long recording continued after the key was released (cutting this much from the end gives the recording without it)
    postRollMs: found.timings?.postRollMs,
    split: item.split,
    category: item.category,
    tags: item.tags ?? [],
    terms: item.terms,
  };
  // A re-recording replaces the row with the same id
  const rows = readRows(SCRIPT_DATASET).filter((r) => r.id !== item.id);
  rows.push(row);
  rows.sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(path.join(dir, 'manifest.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
  appendTruth({ id: item.id, audioSha256: hash, target: item.text, status: 'ok', prefill: 'script', reviewedAt: new Date().toISOString() });
  return { ok: true, durationSec: row.durationSec };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'content-type': type, 'content-length': data.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

async function handle(req: http.IncomingMessage, res: http.ServerResponse, port: number): Promise<void> {
  // Reject requests from other sites (check Host and the token)
  const host = req.headers.host ?? '';
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'forbidden' });
  const url = new URL(req.url ?? '/', `http://${host}`);
  const token = url.searchParams.get('t') ?? String(req.headers['x-longhand-token'] ?? '');
  if (token !== TOKEN) return send(res, 403, { error: 'forbidden' });
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (req.method === 'GET' && parts.length === 0) {
    return send(res, 200, fs.readFileSync(path.join(HERE, 'index.html'), 'utf8').replaceAll('__TOKEN__', TOKEN), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'items') {
    const truth = readTruth();
    const items = REVIEW_DATASETS.flatMap((dataset) =>
      readRows(dataset)
        .filter((row) => fs.existsSync(audioPath(dataset, row)))
        .map((row) => ({
          id: row.id,
          dataset,
          source: row.source ?? 'external',
          durationSec: row.durationSec,
          timestamp: row.timestamp,
          content: row.content,
          rawText: row.rawText,
          paste: row.paste,
          truth: truth.get(row.id) ?? null,
        })),
    ).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return send(res, 200, { items });
  }

  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'audio' && parts[2]) {
    const hit = findRow(parts[2]);
    if (!hit || !fs.existsSync(audioPath(hit.dataset, hit.row))) return send(res, 404, { error: 'not found' });
    return send(res, 200, fs.readFileSync(audioPath(hit.dataset, hit.row)), 'audio/wav');
  }

  if (req.method === 'PUT' && parts[0] === 'api' && parts[1] === 'truth' && parts[2]) {
    const hit = findRow(parts[2]);
    if (!hit) return send(res, 404, { error: 'not found' });
    const body = await readBody(req);
    const status = body.status === 'excluded' ? 'excluded' : 'ok';
    const target = typeof body.target === 'string' ? body.target.trim() : '';
    if (status === 'ok' && !target) return send(res, 400, { error: 'The text is empty. Write what was said, or exclude the recording.' });
    const spoken = typeof body.spoken === 'string' ? body.spoken.trim() : '';
    const alt = strings(body.alt).filter((a) => a !== target);
    const t: Truth = {
      id: hit.row.id,
      audioSha256: hit.row.audioSha256 ?? sha256(fs.readFileSync(audioPath(hit.dataset, hit.row))),
      target,
      ...(spoken && spoken !== target ? { spoken } : {}),
      ...(alt.length ? { alt } : {}),
      status,
      prefill: hit.row.source === 'longhand' ? 'longhand' : 'external',
      reviewedAt: new Date().toISOString(),
    };
    appendTruth(t);
    return send(res, 200, { truth: t });
  }

  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'script') {
    const script = readScript();
    const recorded = new Map(readRows(SCRIPT_DATASET).map((r) => [r.id, r]));
    return send(res, 200, {
      categories: script.categories,
      items: script.items.map((it) => ({ ...it, recorded: recorded.has(it.id) ? { durationSec: recorded.get(it.id)!.durationSec } : null })),
    });
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'script' && parts[2] && parts[3] === 'capture') {
    const item = readScript().items.find((it) => it.id === parts[2]);
    if (!item) return send(res, 404, { error: 'not found' });
    const body = await readBody(req);
    const since = typeof body.since === 'number' ? body.since : Date.now() - 60_000;
    return send(res, 200, await captureScript(item, since));
  }

  return send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  const port = (server.address() as { port: number }).port;
  handle(req, res, port).catch((e) => send(res, 500, { error: (e as Error).message }));
});

server.listen(Number(args.port), '127.0.0.1', () => {
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/?t=${TOKEN}`;
  console.log(`Review page: ${url}`);
  console.log('Press Ctrl+C to stop. Each reference is saved as soon as it is confirmed.');
  if (args.open) execFile('open', [url]);
});
