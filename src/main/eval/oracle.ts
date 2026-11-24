/**
 * 別候補の見込みの計算。書き起こしの「聞き違いかもしれない箇所」の別候補（聞き直し、確信度の低い箇所の別候補）が、
 * どれだけ役に立ちうるかを、実行の結果から見積もる。
 *
 * 箇所ごとに、書き起こしの中の語句（heard）を候補に置き換えてみて、正解との編集距離（中身）が減る候補だけを採る。
 * 正解を見て選ぶので、実際の整形（LLM）が届く上限になる。ここで誤りがほとんど減らなければ、聞き直しと別候補を
 * 整形に渡しても得るものは少ない。
 * 比べる相手として、どの箇所でも 1 番目の候補を採った場合（正解を見ずに書き換えた場合）の誤りも出す。
 * 出すのは数だけ（文は出さない）。
 */
import type { Uncertain } from '../asr/hypotheses';
import { addCer, bestCer, normContent, type Cer } from './metrics';
import type { RowRecord } from './score';

/** 計算に使う、行の一部（rows.jsonl の行がそのまま渡せる） */
export type OracleRow = Pick<RowRecord, 'dataset' | 'target' | 'alt'> & {
  stages: Pick<RowRecord['stages'], 'asr'>;
  asr: Pick<RowRecord['asr'], 'uncertain'>;
};

export interface SourceCount {
  /** 箇所の数 */
  spots: number;
  /** 正解に近づく候補があって、採った数 */
  adopted: number;
  /** 採って減った誤りの数 */
  editsSaved: number;
}

export interface OracleRowResult {
  /** 正解に近づく候補だけを採った書き起こし */
  text: string;
  before: Cer;
  oracle: Cer;
  /** どの箇所でも 1 番目の候補を採った場合 */
  first: Cer;
  spots: number;
  adopted: number;
  /** 書き起こしの中に heard が見つからなかった箇所（前の箇所の置き換えで消えた場合など） */
  notFound: number;
  bySource: Record<string, SourceCount>;
}

function indexesOf(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) out.push(i);
  return out;
}

const replaceAt = (text: string, at: number, len: number, by: string) => text.slice(0, at) + by + text.slice(at + len);

/**
 * 1 つの発話について、箇所を順に見て、正解との編集距離が減る候補だけを採る（1 か所ずつ。前の箇所で採った結果に重ねる）。
 * 同じ語句が何度も出るときは、どの出現を置き換えるかも、距離が最も減るものを選ぶ
 */
export function oracleRow(text: string, refs: readonly string[], uncertain: readonly Uncertain[]): OracleRowResult {
  const score = (t: string): Cer => {
    const c = bestCer(t, refs, normContent);
    return { edits: c.edits, len: c.len };
  };
  const before = score(text);
  const bySource: Record<string, SourceCount> = {};
  let cur = text;
  let curScore = before;
  let blind = text;
  let adopted = 0;
  let notFound = 0;
  for (const u of uncertain) {
    const src = (bySource[u.source] ??= { spots: 0, adopted: 0, editsSaved: 0 });
    src.spots++;
    // 正解を見ずに書き換えた場合: 最初に見つかった所を、1 番目の候補にする
    const blindAt = blind.indexOf(u.heard);
    if (u.heard && blindAt >= 0 && u.alternatives[0] !== undefined) blind = replaceAt(blind, blindAt, u.heard.length, u.alternatives[0]);
    const positions = indexesOf(cur, u.heard);
    if (!positions.length) {
      notFound++;
      continue;
    }
    let best: { text: string; score: Cer } | null = null;
    for (const at of positions) {
      for (const alt of u.alternatives) {
        const cand = replaceAt(cur, at, u.heard.length, alt);
        const s = score(cand);
        if (s.edits < (best?.score.edits ?? curScore.edits)) best = { text: cand, score: s };
      }
    }
    if (!best) continue;
    src.adopted++;
    src.editsSaved += curScore.edits - best.score.edits;
    adopted++;
    cur = best.text;
    curScore = best.score;
  }
  return { text: cur, before, oracle: curScore, first: score(blind), spots: uncertain.length, adopted, notFound, bySource };
}

export interface OracleTotals {
  before: Cer;
  oracle: Cer;
  first: Cer;
}

export interface OracleSummary {
  /** 読んだ発話 */
  rows: number;
  /** 聞き違いかもしれない箇所のある発話 */
  utterances: number;
  /** そのうち、候補を採って誤りが減った発話 */
  improved: number;
  spots: number;
  adopted: number;
  notFound: number;
  /** 全部の発話の誤り */
  all: OracleTotals;
  /** 箇所のある発話だけの誤り */
  target: OracleTotals;
  bySource: Record<string, SourceCount>;
}

const zero = (): OracleTotals => ({ before: { edits: 0, len: 0 }, oracle: { edits: 0, len: 0 }, first: { edits: 0, len: 0 } });

export function oracleSummary(rows: readonly OracleRow[]): OracleSummary {
  const s: OracleSummary = { rows: rows.length, utterances: 0, improved: 0, spots: 0, adopted: 0, notFound: 0, all: zero(), target: zero(), bySource: {} };
  const add = (t: OracleTotals, r: OracleRowResult) => {
    t.before = addCer(t.before, r.before);
    t.oracle = addCer(t.oracle, r.oracle);
    t.first = addCer(t.first, r.first);
  };
  for (const row of rows) {
    const uncertain = row.asr.uncertain ?? [];
    const r = oracleRow(row.stages.asr, [row.target, ...(row.alt ?? [])], uncertain);
    add(s.all, r);
    if (!uncertain.length) continue;
    add(s.target, r);
    s.utterances++;
    if (r.oracle.edits < r.before.edits) s.improved++;
    s.spots += r.spots;
    s.adopted += r.adopted;
    s.notFound += r.notFound;
    for (const [k, v] of Object.entries(r.bySource)) {
      const t = (s.bySource[k] ??= { spots: 0, adopted: 0, editsSaved: 0 });
      t.spots += v.spots;
      t.adopted += v.adopted;
      t.editsSaved += v.editsSaved;
    }
  }
  return s;
}

const SOURCE_LABELS: Record<string, string> = { rehear: '聞き直し', engine2: '2 つ目のエンジン', token: '確信度の低い箇所の別候補' };

const pct2 = (c: Cer) => (c.len ? `${((c.edits / c.len) * 100).toFixed(2)}%` : '-');
const share = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '-');

function totalsLine(label: string, t: OracleTotals): string {
  const saved = t.before.edits - t.oracle.edits;
  const points = t.before.len ? ` ${((saved / t.before.len) * 100).toFixed(2)} ポイント` : '';
  return (
    `${label} もと ${t.before.edits}（${pct2(t.before)}） → 正解に近づく候補だけを採る ${t.oracle.edits}（${pct2(t.oracle)}）、減る誤り ${saved}${points ? `（${points.trim()}）` : ''}` +
    `。参考: どの箇所でも 1 番目の候補を採る ${t.first.edits}（${pct2(t.first)}）`
  );
}

/** 見込みの表示（数だけ） */
export function formatOracle(name: string, s: OracleSummary): string[] {
  const out = [
    `[${name}] 発話 ${s.rows} 件のうち、聞き違いかもしれない箇所のある発話 ${s.utterances} 件（誤りが減った発話 ${s.improved} 件）`,
    `  箇所 ${s.spots}、採った ${s.adopted}（${share(s.adopted, s.spots)}）${s.notFound ? `、書き起こしに見つからなかった箇所 ${s.notFound}` : ''}`,
    `  ${totalsLine('誤り数（全部の発話）', s.all)}`,
    `  ${totalsLine('誤り数（箇所のある発話だけ）', s.target)}`,
  ];
  for (const [k, v] of Object.entries(s.bySource).sort(([a], [b]) => (a < b ? -1 : 1))) {
    out.push(`  根拠ごと ${SOURCE_LABELS[k] ?? k}: 箇所 ${v.spots}、採った ${v.adopted}（${share(v.adopted, v.spots)}）、減る誤り ${v.editsSaved}`);
  }
  return out;
}
