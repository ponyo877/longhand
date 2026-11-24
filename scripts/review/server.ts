/**
 * 評価の正解を作るための、手元だけで動く確認用の画面。
 *
 *   npx tsx scripts/review/server.ts          # 起動して URL を表示する
 *   npx tsx scripts/review/server.ts --open   # 既定のブラウザで開く
 *
 * できること:
 * - 正解の確認: 取り込んだ録音（~/longhand-eval/datasets/）を聞き、入力されるべき文を確かめて ~/longhand-eval/truth.jsonl に追記する
 * - 台本の読み上げ: scripts/review/script-v1.json の文を Longhand で音声入力してもらい、その録音を script-v1 として取り込む
 *
 * 個人の書き起こしを扱うので、127.0.0.1 だけで待ち受け、URL に付けた合い言葉が合わない要求は断る。
 * 画面には何も保存しない（正解は追記だけのファイルに置くので、途中でやめても続きから再開できる）。
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
    // 起動し直しても同じ URL を使い続けたいときに、前回の合い言葉を渡す
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
/** 正解の確認の対象にするデータセット（台本は、読んだ文がそのまま正解なので対象にしない） */
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
  /** 入力されるべき文 */
  target: string;
  /** 話したままの文（言い直しやつなぎ言葉がある発話だけ） */
  spoken?: string;
  /** 表記ゆれの別解 */
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

/** 同じ id は最後の行が有効 */
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
// 台本の録音の取り込み
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
 * since より後に始まった Longhand の録音のうち、いちばん新しいものを台本の文の録音として取り込む。
 * 履歴は少し遅れて書かれるので、見つかるまで待つ。
 */
async function captureScript(item: ScriptItem, since: number): Promise<{ ok: true; durationSec: number } | { ok: false; reason: string }> {
  let found: LonghandHistoryItem | undefined;
  for (let i = 0; i < 40 && !found; i++) {
    found = longhandHistory()
      .filter((h) => h.timestamp >= since - 1500 && h.audioFile && h.paste !== 'cancelled' && h.mode === 'dictation')
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    if (!found) await sleep(250);
  }
  if (!found?.audioFile) return { ok: false, reason: 'Longhand の履歴に、この文の録音が見つかりませんでした。Longhand で話したかを確かめて、もう一度読んでください。' };
  const src = path.join(LONGHAND_APP, 'recordings', path.basename(found.audioFile));
  if (!fs.existsSync(src)) return { ok: false, reason: '録音のファイルが見つかりませんでした。Longhand の設定で「録音を保存する」がオンかを確かめてください。' };
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
    // 録ったときの Longhand の出力（参考。正解は台本の文）
    rawText: found.rawText,
    longhandText: found.text,
    content: item.text,
    source: 'script',
    audioSha256: hash,
    sampleRate: wav.sampleRate,
    importedAt: new Date().toISOString(),
    // キーを離した後も録音を続けた時間（末尾のこの長さを切り落とすと、続けなかった場合の録音になる）
    postRollMs: found.timings?.postRollMs,
    split: item.split,
    category: item.category,
    tags: item.tags ?? [],
    terms: item.terms,
  };
  // 録り直しでは、同じ id の行を置き換える
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
    if (size > 256 * 1024) throw new Error('大きすぎます');
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
  // ほかのサイトからの要求を断る（Host の確認と、合い言葉の確認）
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
    if (status === 'ok' && !target) return send(res, 400, { error: '文が空です。話した内容を書くか、除外してください。' });
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
  console.log(`確認用の画面: ${url}`);
  console.log('止めるときは Ctrl+C を押します。正解は 1 件ごとに保存されます。');
  if (args.open) execFile('open', [url]);
});
