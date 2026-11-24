/**
 * Word-level transcript fixes (textfix).
 *
 * Exports only fixText, a pure synchronous function. Each rule proposes fixes against the text before fixing, and this module
 * drops the ones in protected ranges (user dictionary words, replacement triggers, dictionary match candidates), the ones the user turned off,
 * and the ones overlapping an earlier rule, then applies the rest at once. All positions are indices into the text before fixing, so the rules are independent.
 *
 * The policy is to fix conservatively. Only spots that match a fixed list or have low confidence are fixed; unclear spots stay as candidates for the LLM.
 */
import { fixFillers } from './fillers';
import { fixLatin } from './latin';
import { fixNotation } from './notation';
import { fixParticles } from './particles';
import { FIX_RULES, fixKey, type FixEdit, type FixInput, type FixOutput, type FixRule, type LexiconCandidate, type Token } from './types';

export type { FixEdit, FixInput, FixOutput, FixRule, LexiconCandidate, Token, Tokenizer } from './types';
export { FIX_RULES, fixKey } from './types';

/** Context passed to a rule */
export interface RuleContext {
  text: string;
  input: FixInput;
  /** Tokenizer output. null if there is no tokenizer or it failed */
  tokens(): Token[] | null;
}

export interface RuleResult {
  edits: FixEdit[];
  candidates?: LexiconCandidate[];
  /** Why the rule was skipped */
  skipped?: string;
}

type RuleFn = (ctx: RuleContext) => RuleResult;

/** Rule implementations. The order is the priority (on overlap, the earlier rule's proposal wins) */
const RULES: Record<FixRule, RuleFn | null> = {
  latin: fixLatin,
  fillers: fixFillers,
  notation: (ctx) => fixNotation(ctx),
  particles: fixParticles,
};

/** Replaces a rule (for tests) */
export function setRuleForTest(rule: FixRule, fn: RuleFn | null): void {
  RULES[rule] = fn;
}

/** Ranges of protected phrases in the text */
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
        // Keep running the other rules if the tokenizer fails (do not stop dictation)
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
      // A zero-length insertion conflicts only with an insertion at the same position
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

/** The text with only one fix applied (used in evaluation to judge each fix on its own) */
export function applyOne(text: string, edit: FixEdit): string {
  return text.slice(0, edit.start) + edit.after + text.slice(edit.end);
}
