/**
 * 評価のデータセットと正解の読み込み。
 *
 * - データセット: <root>/datasets/<名前>/manifest.jsonl と audio/（scripts/eval-import.ts が作る）
 * - 正解: <root>/truth.jsonl。追記だけで、同じ id は最後の行が有効
 * - 正解がまだ無い発話は、manifest の content（そのアプリが入力した文）を仮の正解として使い、仮であることを残す
 * - 開発用（dev）と確認用（holdout）の分け方: 台本の読み上げは行の split（A が開発用、B が確認用）に従う。
 *   自然な発話は、時刻の順に並べて 3 分以上あいたら別の塊とし、塊を時刻の順に、その時点で件数の少ない側に入れる（同数なら開発用）。
 *   続けて話した発話は内容が似るので、発話ごとに振ると確認用に開発用とほぼ同じ文が混ざる。そのため塊は割らない。
 *   時刻の無い発話（公開データ）は、文の番号（無ければ id）のハッシュで振る。同じ文を別の人が読んだ録音は、同じ側に入る
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, sha256Hex } from './files';

/** manifest.jsonl の 1 行（scripts/eval-import.ts の Row。最初の取り込みには source 以降が無い） */
export interface ManifestRow {
  id: string;
  /** データセットのフォルダからの相対パス */
  audio: string;
  durationSec: number;
  timestamp: string;
  kind: string;
  rawText: string;
  content: string;
  source?: string;
  audioSha256?: string;
  sampleRate?: number;
  /** 台本の読み上げだけ: A は開発用、B は確認用 */
  split?: 'A' | 'B';
  tags?: string[];
  /** 台本の読み上げだけ: その文に出る用語 */
  terms?: string[];
  /** 公開データだけ: 読み上げた文の番号（同じ文を複数の人が読んでいる） */
  sentenceId?: string;
  /** 台本の読み上げだけ: 文の種類（lexicon、unlisted、number、homophone、particle、short、long、mixed） */
  category?: string;
  /** キーを離した後に録った長さ（ms）。離した後も録音を続けるようになってからの録音だけ */
  postRollMs?: number;
}

/** truth.jsonl の 1 行 */
export interface TruthRow {
  id: string;
  audioSha256: string;
  /** 入力されるべき文 */
  target: string;
  /** 話したままの文（無ければ target と同じ） */
  spoken?: string;
  /** 表記ゆれの別解 */
  alt?: string[];
  tags?: string[];
  status: 'ok' | 'excluded';
  prefill: 'external' | 'longhand' | 'script' | 'public';
  reviewedAt: string;
}

export type Split = 'dev' | 'holdout';

/** 評価する 1 つの発話 */
export interface Utterance {
  id: string;
  dataset: string;
  audioPath: string;
  audioSha256: string;
  durationSec: number;
  /** 録音した時刻（ms エポック）。分からなければ 0 */
  timestamp: number;
  split: Split;
  /** 自然な発話の塊の番号（データセットの中で 0 から）。台本と、時刻の無い発話は -1 */
  chunk: number;
  target: string;
  spoken: string;
  alt: string[];
  tags: string[];
  terms: string[];
  /** 台本の文の種類。無いデータセットでは undefined */
  category?: string;
  /** キーを離した後に録った長さ（ms）。分からなければ undefined */
  postRollMs?: number;
  /** 正解が仮か（人が確かめていない。manifest の content を使った） */
  provisional: boolean;
}

export interface DatasetCounts {
  rows: number;
  used: number;
  /** 正解が仮の発話（used のうち） */
  provisional: number;
  /** 人が確かめた正解のある発話（used のうち） */
  reviewed: number;
  /** 正解で除外になっている発話 */
  excluded: number;
  /** 正解も content も無い発話 */
  noReference: number;
  /** 正解の音声のハッシュが違う発話（仮の正解に戻した） */
  hashMismatch: number;
  missingAudio: number;
}

/** 自然な発話を別の塊とみなす間隔 */
export const CHUNK_GAP_MS = 3 * 60 * 1000;

function parseTime(timestamp: string): number {
  const t = Date.parse(timestamp);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 発話を開発用と確認用に分ける。データセットの行をすべて渡す（正解の有無で塊が変わらないように、使わない行も含める）。
 *
 * 自然な発話は、時刻の順に塊を作り、塊ごとに、その時点で件数の少ない側に入れる（同数なら開発用）。塊は割らない。
 * 件数に数えるのは、文のある行（content が空でない行）だけ。取り消した録音などの文の無い行は、塊には入るが件数には数えない。
 * 後から行が増えても、時刻が後ろに足されるかぎり、前の行の振り分けは変わらない
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
      // 時刻が無いと塊を作れない。文の番号（無ければ id）のハッシュの偶奇で振る
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

/** 正解を読む。同じ id は最後の行が有効。ファイルが無ければ空 */
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

/** データセットを読み、正解と突き合わせて、評価する発話の一覧にする（時刻の順） */
export function loadDataset(root: string, name: string, truth: ReadonlyMap<string, TruthRow>): LoadedDataset {
  const dir = path.join(root, 'datasets', name);
  if (!fs.existsSync(path.join(dir, 'manifest.jsonl'))) throw new Error(`データセットが見つかりません: ${dir}`);
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
    // 最初の取り込みの行にはハッシュが無いので、音声から求める
    const audioSha256 = row.audioSha256 || sha256Hex(fs.readFileSync(audioPath));
    let t = truth.get(row.id);
    if (t?.status === 'excluded') {
      counts.excluded++;
      continue;
    }
    if (t && t.audioSha256 && t.audioSha256 !== audioSha256) {
      // 別の音声に付けた正解は使わない
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

/** 1 行 1 語のファイルを読む（辞書の語。既存の --vocab と同じ形）。空行と重複は除く */
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
