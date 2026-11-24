/**
 * 規則 c: 表記をそろえる。補助動詞、形式名詞、一部の副詞を、漢字からかなにする（向きは漢字→かなだけ）。
 *
 * 基本形と品詞をキーにした表で直すので、同じ字でも本来の意味の語（「水を下さい」「時が経つ」「是非を問う」）は残る。
 * - 補助動詞（下さる、頂く、頂ける、致す）は、品詞の細分類が非自立か、直前が接続助詞の「て」「で」のときだけ
 * - 形式名詞（事、物、時、所、為、訳）は、細分類が非自立のときだけ
 * - 副詞（全て、既に、更に、是非、勿論）は、表の品詞と一致するときだけ
 * 評価の参照文で漢字の書き方のほうが多かった項目は、表に入れていない（docs/evaluation.md を参照）。
 */
import type { RuleContext, RuleResult } from './index';
import type { FixEdit, Token } from './types';

export interface NotationEntry {
  /** 基本形 */
  base: string;
  pos: string;
  /** 品詞の細分類。指定があれば一致するときだけ */
  pos1?: string;
  /** 表層形の先頭の漢字と、置き換えるかな（活用した形も先頭だけを置き換える） */
  kanji: string;
  kana: string;
  /** 補助動詞として使われたときだけ（細分類が非自立か、直前が「て」「で」） */
  aux?: boolean;
}

export const NOTATION_TABLE: NotationEntry[] = [
  // 補助動詞
  { base: '下さる', pos: '動詞', kanji: '下', kana: 'くだ', aux: true },
  { base: '頂く', pos: '動詞', kanji: '頂', kana: 'いただ', aux: true },
  { base: '頂ける', pos: '動詞', kanji: '頂', kana: 'いただ', aux: true },
  { base: '致す', pos: '動詞', kanji: '致', kana: 'いた', aux: true },
  // 形式名詞
  { base: '事', pos: '名詞', pos1: '非自立', kanji: '事', kana: 'こと' },
  { base: '物', pos: '名詞', pos1: '非自立', kanji: '物', kana: 'もの' },
  { base: '時', pos: '名詞', pos1: '非自立', kanji: '時', kana: 'とき' },
  { base: '所', pos: '名詞', pos1: '非自立', kanji: '所', kana: 'ところ' },
  { base: '為', pos: '名詞', pos1: '非自立', kanji: '為', kana: 'ため' },
  { base: '訳', pos: '名詞', pos1: '非自立', kanji: '訳', kana: 'わけ' },
  // 副詞
  { base: '全て', pos: '名詞', pos1: '副詞可能', kanji: '全て', kana: 'すべて' },
  { base: '既に', pos: '副詞', kanji: '既に', kana: 'すでに' },
  { base: '更に', pos: '副詞', kanji: '更に', kana: 'さらに' },
  { base: '是非', pos: '副詞', kanji: '是非', kana: 'ぜひ' },
  { base: '勿論', pos: '副詞', kanji: '勿論', kana: 'もちろん' },
];

const isTeDe = (t: Token | undefined) => !!t && t.pos === '助詞' && t.pos1 === '接続助詞' && (t.surface === 'て' || t.surface === 'で');

/** 表の項目に当たるか */
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
