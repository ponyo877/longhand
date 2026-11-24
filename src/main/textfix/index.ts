/**
 * 書き起こしの語ごとの補正（textfix）。
 *
 * 同期で動く純粋な関数 fixText だけを外に出す。規則はそれぞれ「直す前の文字列」に対して直す箇所を提案し、
 * ここで、触らない範囲（利用者の辞書の語、置換のきっかけ、辞書照合の候補）、利用者が止めた箇所、
 * 先の規則との重なりを除いてから、まとめて当てる。位置はどれも直す前の文字列の添字なので、規則どうしは独立している。
 *
 * 控えめに直すのが方針である。決まった一覧に一致した所と、確信度の低い所だけを直し、迷う所は LLM への候補にとどめる。
 */
import { fixFillers } from './fillers';
import { fixLatin } from './latin';
import { fixNotation } from './notation';
import { fixParticles } from './particles';
import { FIX_RULES, fixKey, type FixEdit, type FixInput, type FixOutput, type FixRule, type LexiconCandidate, type Token } from './types';

export type { FixEdit, FixInput, FixOutput, FixRule, LexiconCandidate, Token, Tokenizer } from './types';
export { FIX_RULES, fixKey } from './types';

/** 規則に渡す文脈 */
export interface RuleContext {
  text: string;
  input: FixInput;
  /** 単語分割の結果。単語分割がないか失敗したら null */
  tokens(): Token[] | null;
}

export interface RuleResult {
  edits: FixEdit[];
  candidates?: LexiconCandidate[];
  /** 規則を飛ばした理由 */
  skipped?: string;
}

type RuleFn = (ctx: RuleContext) => RuleResult;

/** 規則の実装。並びが優先順位（重なったら先の規則の提案を採る） */
const RULES: Record<FixRule, RuleFn | null> = {
  latin: fixLatin,
  fillers: fixFillers,
  notation: (ctx) => fixNotation(ctx),
  particles: fixParticles,
};

/** 規則を差し替える（テスト用） */
export function setRuleForTest(rule: FixRule, fn: RuleFn | null): void {
  RULES[rule] = fn;
}

/** 文中に出てくる、守る語句の範囲 */
function protectedRanges(text: string, phrases: readonly string[] | undefined): [number, number][] {
  const out: [number, number][] = [];
  const lower = text.toLowerCase();
  for (const p of phrases ?? []) {
    const q = p.trim().toLowerCase();
    if (!q) continue;
    for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + 1)) out.push([i, i + q.length]);
  }
  return out;
}

const overlaps = (a: { start: number; end: number }, s: number, e: number) => a.start < e && s < a.end;

export function fixText(input: FixInput): FixOutput {
  const text = input.text;
  const out: FixOutput = { text, edits: [], candidates: [], skipped: [] };
  if (input.language !== 'ja' || !text.trim()) return out;
  const enabled = FIX_RULES.filter((r) => input.rules[r] && RULES[r]);
  if (!enabled.length) return out;

  let cached: Token[] | null | undefined;
  const ctx: RuleContext = {
    text,
    input,
    tokens: () => {
      if (cached !== undefined) return cached;
      try {
        cached = input.tokenizer?.tokenize(text) ?? null;
      } catch {
        // 単語分割が失敗しても、ほかの規則は続ける（音声入力を止めない）
        cached = null;
      }
      return cached;
    },
  };
  const guard = protectedRanges(text, input.protectedPhrases);
  const blocked = new Set(input.blocked ?? []);
  const accepted: FixEdit[] = [];
  for (const rule of enabled) {
    let res: RuleResult;
    try {
      res = RULES[rule]!(ctx);
    } catch {
      out.skipped.push(`${rule}: error`);
      continue;
    }
    if (res.skipped) out.skipped.push(`${rule}: ${res.skipped}`);
    for (const c of res.candidates ?? []) if (!out.candidates.some((x) => x.heard === c.heard && x.word === c.word)) out.candidates.push(c);
    for (const e of res.edits) {
      if (e.before === e.after || e.start < 0 || e.end > text.length || e.start > e.end) continue;
      if (text.slice(e.start, e.end) !== e.before) continue;
      if (guard.some(([s, en]) => overlaps(e, s, en))) continue;
      if (blocked.has(fixKey(e))) continue;
      // 長さ 0 の挿入は、同じ位置の挿入とだけぶつかる
      if (accepted.some((a) => overlaps(a, e.start, e.end) || (a.start === e.start && (a.end === a.start || e.end === e.start)))) continue;
      accepted.push(e);
    }
  }
  if (!accepted.length) return out;
  accepted.sort((a, b) => a.start - b.start || a.end - b.end);
  let result = '';
  let pos = 0;
  for (const e of accepted) {
    result += text.slice(pos, e.start) + e.after;
    pos = e.end;
  }
  result += text.slice(pos);
  out.text = result;
  out.edits = accepted;
  return out;
}

/** 1 か所だけを当てた文（評価で、直した箇所ごとの正否を見るのに使う） */
export function applyOne(text: string, edit: FixEdit): string {
  return text.slice(0, edit.start) + edit.after + text.slice(edit.end);
}
