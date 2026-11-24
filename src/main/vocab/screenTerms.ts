/**
 * 入力先の画面の文から、その場で使われている用語（英字の製品名や技術用語）を拾う。
 *
 * 利用者の辞書が空でも、いま開いている文書やチャットに出ている語は、次に話す語である可能性が高い。
 * 拾った語は、その発話のあいだだけ、音声認識のヒントと整形の語彙に足す（辞書には入れない）。
 * 画面の文そのものは、語を拾ったら捨てる（保存しない、外に送らない）。
 *
 * 考え方は、MIT ライセンスの音声入力アプリ Hex（anomalyco/hex）の、画面からの語彙の抽出を参考にした（コードは写していない）。
 */
import { extractCandidates } from '../../shared/dictCandidates';

/** 画面でよく見る、メニューやボタンの英語。用語ではないので外す */
const UI_WORDS = new Set(
  (
    'file edit view window help tools format insert table history bookmarks profiles tab tabs page pages ' +
    'ok cancel save open close delete copy paste cut undo redo send reply forward share search find replace ' +
    'home back next previous new add remove settings preferences options menu sign login logout log account ' +
    'yes no done apply submit continue skip retry update upgrade download upload print export import ' +
    'monday tuesday wednesday thursday friday saturday sunday january february march april june july august ' +
    'september october november december today yesterday tomorrow ' +
    'mon tue wed thu fri sat sun jan feb mar apr jun jul aug sep oct nov dec ' +
    'untitled draft inbox sent trash spam all none more less show hide'
  ).split(' '),
);

export interface ScreenTermOptions {
  /** すでに辞書にある語（重ねて拾わない） */
  existing?: readonly string[];
  /** 返す語の上限 */
  limit?: number;
}

/**
 * 文から、名前らしい英字の語を、出てきた回数の多い順に返す。
 * texts には、入力欄のカーソルの前後、ウィンドウのタイトル、画面の文などを渡す。
 */
export function extractScreenTerms(texts: readonly (string | undefined)[], opts: ScreenTermOptions = {}): string[] {
  const docs = texts.filter((t): t is string => !!t && t.trim().length > 0);
  if (!docs.length) return [];
  const limit = opts.limit ?? 24;
  return extractCandidates(docs, { existing: [...(opts.existing ?? [])], namesOnly: true, maxLength: 32, limit: limit * 3 })
    .map((c) => c.word)
    .filter((w) => !UI_WORDS.has(w.toLowerCase()))
    .filter((w) => !/^\d/.test(w) || /[A-Za-z]{2}/.test(w))
    .slice(0, limit);
}
