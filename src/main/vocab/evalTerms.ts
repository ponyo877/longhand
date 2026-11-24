/**
 * 辞書の語についての評価の補助（G4-19）。評価（src/main/eval）から使う。
 * - termRecall: 参照文に出る辞書の語のうち、出力に同じ表記で出た割合（再現率）
 * - falseInsertions: 参照文より多く出力に出た辞書の語の数（誤挿入）
 * - inventedTerms: 大きな辞書をまねるための、実在しない語
 * - orderHintsForEval: 評価用のヒントの並べ方（今の新しい順か、得点順か）
 */
import { countTerm, rankVocabulary, type VocabEntry } from './hints';

function norm(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

export interface TermCount {
  term: string;
  reference: number;
  output: number;
}

/** 語ごとの出現回数（NFKC と大文字小文字を無視。英字の語は前後が英数字でない位置だけ） */
export function termCounts(reference: string, output: string, terms: string[]): TermCount[] {
  const r = norm(reference);
  const o = norm(output);
  return terms
    .map((t) => t.trim())
    .filter(Boolean)
    .map((term) => ({ term, reference: countTerm(r, norm(term)), output: countTerm(o, norm(term)) }));
}

/** 再現率の分子と分母。分子は語ごとに min(出力の回数, 参照の回数) を足したもの */
export function termRecall(reference: string, output: string, terms: string[]): { hit: number; total: number } {
  let hit = 0;
  let total = 0;
  for (const c of termCounts(reference, output, terms)) {
    total += c.reference;
    hit += Math.min(c.reference, c.output);
  }
  return { hit, total };
}

/** 誤挿入の数。語ごとに max(0, 出力の回数 - 参照の回数) を足したもの */
export function falseInsertions(reference: string, output: string, terms: string[]): number {
  return termCounts(reference, output, terms).reduce((n, c) => n + Math.max(0, c.output - c.reference), 0);
}

/** 再現できなかった語と、誤って出た語の一覧（結果のファイルに残す用） */
export function termDetails(reference: string, output: string, terms: string[]): { missed: string[]; inserted: string[] } {
  const cs = termCounts(reference, output, terms);
  return {
    missed: cs.filter((c) => c.output < c.reference).map((c) => c.term),
    inserted: cs.filter((c) => c.output > c.reference).map((c) => c.term),
  };
}

const ONSETS = ['b', 'd', 'f', 'g', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'z', 'br', 'dr', 'kl', 'pr', 'st', 'tr', 'qu', 'x'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'io', 'y'];
const CODAS = ['', '', 'n', 'r', 'x', 'l', 'm', 'k', 'th', 'sk'];

/**
 * 実在しない語を n 個作る（seed が同じなら同じ語）。英字の製品名のような 2〜3 音節の語。
 * 評価の「大きな辞書」をまねるために、本物の辞書の語の後ろ（新しい語）に足す。
 */
export function inventedTerms(n: number, seed = 1): string[] {
  let x = seed >>> 0 || 1;
  const rand = (k: number) => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x % k;
  };
  const out = new Set<string>();
  let guard = 0;
  while (out.size < n && guard++ < n * 50) {
    const syll = 2 + rand(2);
    let w = '';
    for (let i = 0; i < syll; i++) w += ONSETS[rand(ONSETS.length)] + VOWELS[rand(VOWELS.length)];
    w += CODAS[rand(CODAS.length)];
    out.add(w.charAt(0).toUpperCase() + w.slice(1));
  }
  return [...out];
}

/**
 * 評価用にヒントを並べる。
 * - recent: 今の方法をまねる（登録順の新しい語から）。terms は古い順に並んでいるものとする
 * - score: 得点順。評価データには入力欄の文脈がないので、ほかの発話の参照文を「最近の書き起こし」として数える
 *   （その発話自身は含めないこと。呼び出し側で除いて渡す）
 */
export function orderHintsForEval(terms: string[], otherReferences: string[], order: 'recent' | 'score', limit = 64): string[] {
  if (order === 'recent') return [...terms].reverse().slice(0, limit);
  const n = terms.length;
  const entries: VocabEntry[] = terms.map((word, i) => ({ word, recency: n > 1 ? i / (n - 1) : 1 }));
  const now = Date.now();
  const recent = otherReferences.map((text) => ({ text, timestamp: now }));
  return rankVocabulary(entries, { recent, now })
    .slice(0, limit)
    .map((s) => s.word);
}
