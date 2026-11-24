/**
 * Rule c: normalizes notation. Turns auxiliary verbs, formal nouns and some adverbs from kanji into kana (kanji → kana only).
 *
 * The table is keyed by base form and part of speech, so words with the same characters used in their literal sense (「水を下さい」, 「時が経つ」, 「是非を問う」) stay.
 * - Auxiliary verbs (下さる, 頂く, 頂ける, 致す) only when the subcategory is 非自立 or the token right before is the conjunctive particle 「て」 or 「で」
 * - Formal nouns (事, 物, 時, 所, 為, 訳) only when the subcategory is 非自立
 * - Adverbs (全て, 既に, 更に, 是非, 勿論) only when the part of speech matches the table
 * Items written in kanji more often than in kana in the evaluation references are left out of the table (see docs/evaluation.md).
 */
import type { RuleContext, RuleResult } from './index';
import type { FixEdit, Token } from './types';

export interface NotationEntry {
  /** Base form */
  base: string;
  pos: string;
  /** Part-of-speech subcategory. If set, only when it matches */
  pos1?: string;
  /** Kanji at the start of the surface form and the kana that replaces it (conjugated forms also have only the start replaced) */
  kanji: string;
  kana: string;
  /** Only when used as an auxiliary verb (subcategory 非自立, or 「て」 or 「で」 right before) */
  aux?: boolean;
}

export const NOTATION_TABLE: NotationEntry[] = [
  // Auxiliary verbs
  { base: '下さる', pos: '動詞', kanji: '下', kana: 'くだ', aux: true },
  { base: '頂く', pos: '動詞', kanji: '頂', kana: 'いただ', aux: true },
  { base: '頂ける', pos: '動詞', kanji: '頂', kana: 'いただ', aux: true },
  { base: '致す', pos: '動詞', kanji: '致', kana: 'いた', aux: true },
  // Formal nouns
  { base: '事', pos: '名詞', pos1: '非自立', kanji: '事', kana: 'こと' },
  { base: '物', pos: '名詞', pos1: '非自立', kanji: '物', kana: 'もの' },
  { base: '時', pos: '名詞', pos1: '非自立', kanji: '時', kana: 'とき' },
  { base: '所', pos: '名詞', pos1: '非自立', kanji: '所', kana: 'ところ' },
  { base: '為', pos: '名詞', pos1: '非自立', kanji: '為', kana: 'ため' },
  { base: '訳', pos: '名詞', pos1: '非自立', kanji: '訳', kana: 'わけ' },
  // Adverbs
  { base: '全て', pos: '名詞', pos1: '副詞可能', kanji: '全て', kana: 'すべて' },
  { base: '既に', pos: '副詞', kanji: '既に', kana: 'すでに' },
  { base: '更に', pos: '副詞', kanji: '更に', kana: 'さらに' },
  { base: '是非', pos: '副詞', kanji: '是非', kana: 'ぜひ' },
  { base: '勿論', pos: '副詞', kanji: '勿論', kana: 'もちろん' },
];

const isTeDe = (t: Token | undefined) => !!t && t.pos === '助詞' && t.pos1 === '接続助詞' && (t.surface === 'て' || t.surface === 'で');

/** Whether the token matches a table entry */
export function notationEntry(tokens: readonly Token[], i: number, table: readonly NotationEntry[] = NOTATION_TABLE): NotationEntry | null {
  const t = tokens[i];
  for (const e of table) {
    if (t.base !== e.base || t.pos !== e.pos) continue;
    if (e.pos1 && t.pos1 !== e.pos1) continue;
    if (e.aux && !(t.pos1 === '非自立' || (isTeDe(tokens[i - 1]) && tokens[i - 1].end === t.start))) continue;
    if (!t.surface.startsWith(e.kanji)) continue;
    return e;
  }
  return null;
}

export function fixNotation(ctx: RuleContext, table: readonly NotationEntry[] = NOTATION_TABLE): RuleResult {
  const tokens = ctx.tokens();
  if (!tokens) return { edits: [], skipped: 'no-tokenizer' };
  const edits: FixEdit[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const e = notationEntry(tokens, i, table);
    if (!e) continue;
    const t = tokens[i];
    edits.push({ rule: 'notation', start: t.start, end: t.end, before: t.surface, after: e.kana + t.surface.slice(e.kanji.length) });
  }
  return { edits };
}
