/**
 * Types for word-level transcript fixes (textfix).
 * Fixes text pasted without the LLM (fast path, no LLM, LLM failure) using fixed rules only.
 */

/** Rule names. a: katakana to Latin letters, b: fillers, c: notation, d: particles */
export type FixRule = 'latin' | 'fillers' | 'notation' | 'particles';

export const FIX_RULES: readonly FixRule[] = ['latin', 'fillers', 'notation', 'particles'];

/** One fix. Positions are indices into the input string (before fixing) */
export interface FixEdit {
  rule: FixRule;
  start: number;
  end: number;
  before: string;
  after: string;
}

/** A glossary candidate for the LLM (not fixed, but possibly a Latin-letter word) */
export interface LexiconCandidate {
  heard: string;
  word: string;
}

/** One token from the tokenizer (IPADIC parts of speech) */
export interface Token {
  /** Surface form */
  surface: string;
  /** Position in the input string [start, end) */
  start: number;
  end: number;
  /** Part of speech (名詞, 動詞, 助詞, フィラー and so on) and subcategory */
  pos: string;
  pos1: string;
  /** Base form. The surface form if unknown */
  base: string;
  /** Reading (katakana). Empty if unknown */
  reading: string;
}

/** Tokenizes synchronously. Returns null while still loading */
export interface Tokenizer {
  tokenize(text: string): Token[] | null;
}

export interface FixInput {
  text: string;
  /** Language setting. Fixes only for Japanese (ja) */
  language: string;
  /** On or off for each rule. Rules not listed are off */
  rules: Partial<Record<FixRule, boolean>>;
  /** Phrases to leave alone (user dictionary words, replacement triggers, dictionary match candidates). Every occurrence in the text is protected */
  protectedPhrases?: readonly string[];
  /** User dictionary words (their Latin spellings take priority, and they are also a condition for fixing tier 2 words) */
  vocabulary?: readonly string[];
  /** Target app and browser host name (a condition for fixing tier 2 words) */
  app?: { bundleId?: string; name?: string; host?: string };
  /** Spots the user chose not to fix again (in fixKey form) */
  blocked?: readonly string[];
  /** Tokenizer. Without it, rules that need tokens are skipped */
  tokenizer?: Tokenizer | null;
  /** Per-character confidence (0 to 1, per index of the input string). null for unknown characters. Without it, rules that need confidence are skipped */
  confidence?: readonly (number | null)[] | null;
  /** Whether rule d removes a 「を」 added by Whisper (the rule's default if unset) */
  dropWo?: boolean;
}

export interface FixOutput {
  /** Fixed text. The input unchanged if there was nothing to fix */
  text: string;
  edits: FixEdit[];
  /** Candidates for the LLM (spots not fixed, such as tier 2 words) */
  candidates: LexiconCandidate[];
  /** Skipped rules and why (no tokenizer, for example) */
  skipped: string[];
}

/** Key used to record "don't fix again". Determined by the rule and the text before fixing */
export function fixKey(edit: Pick<FixEdit, 'rule' | 'before'>): string {
  return `${edit.rule}:${edit.before}`;
}
