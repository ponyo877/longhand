/**
 * 規則 b: つなぎの言葉（えっと、あのー など）を取り除く。
 *
 * - 決まった一覧の語だけを消す。IPADIC はつなぎの言葉の分け方がまちまちなので（「えっと」が「えっ」と「と」になる など）、
 *   単語の境目にそろった 1〜4 語の並びをつないで一覧と比べる
 * - 発話の先頭か、読点と句点の前後にあるものだけを消す。文の途中で句読点に挟まれていないものは残す
 * - 「あの」「その」は、すぐ後が読点か句点のときだけ消す（「あの人」「その件」は残す）
 * - かぎ括弧の中、「と」「って」の前（引用）、消すと中身がなくなる場合は触らない
 * - 「うん」「はい」「まあ」「なんか」は一覧に入れない（内容の一部であることが多い）
 */
import type { RuleContext, RuleResult } from './index';
import type { FixEdit, Token } from './types';

/** 消す語（長音の重なりは 1 つにまとめてから比べる） */
const FILLERS = new Set(['えー', 'えーと', 'えっと', 'ええと', 'えーっと', 'あのー', 'あのう', 'うーん', 'んー']);
/** すぐ後が句読点のときだけ消す語 */
const DEMONSTRATIVES = new Set(['あの', 'その']);
const PUNCT = new Set(['、', '。']);
const MAX_TOKENS = 4;

const norm = (s: string) => s.replace(/ー+/g, 'ー');

/** かぎ括弧の中の範囲 */
function quotedRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '「' || c === '『') stack.push(i);
    else if ((c === '」' || c === '』') && stack.length) {
      const s = stack.pop()!;
      if (!stack.length) out.push([s, i + 1]);
    }
  }
  // 閉じていないかぎ括弧は、末尾までを中とみなす
  if (stack.length) out.push([stack[0], text.length]);
  return out;
}

/** 空白を飛ばした、直前と直後の文字 */
function prevChar(text: string, i: number): string {
  let k = i - 1;
  while (k >= 0 && /\s/.test(text[k])) k--;
  return k >= 0 ? text[k] : '';
}
function nextIndex(text: string, i: number): number {
  let k = i;
  while (k < text.length && /\s/.test(text[k])) k++;
  return k;
}

const hasSubstance = (s: string) => /[\p{L}\p{N}]/u.test(s);

/** 単語の境目から始まり境目で終わる、一覧の語の並びを探す。見つかれば終わりの語の添字 */
function matchFiller(tokens: readonly Token[], i: number): number | null {
  let joined = '';
  let found: number | null = null;
  for (let j = i; j < Math.min(tokens.length, i + MAX_TOKENS); j++) {
    // 語の間に空白などの隙間があれば、つながっていない
    if (j > i && tokens[j].start !== tokens[j - 1].end) break;
    joined += tokens[j].surface;
    if (FILLERS.has(norm(joined))) found = j;
  }
  return found;
}

export function fixFillers(ctx: RuleContext): RuleResult {
  const tokens = ctx.tokens();
  if (!tokens) return { edits: [], skipped: 'no-tokenizer' };
  const text = ctx.text;
  const quoted = quotedRanges(text);
  const edits: FixEdit[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let last = matchFiller(tokens, i);
    let demonstrative = false;
    if (last === null && DEMONSTRATIVES.has(t.surface) && (t.pos === '連体詞' || t.pos === 'フィラー')) {
      last = i;
      demonstrative = true;
    }
    if (last === null) continue;
    const start = t.start;
    const end = tokens[last].end;
    const before = prevChar(text, start);
    const ni = nextIndex(text, end);
    const after = text[ni] ?? '';
    const atStart = !text.slice(0, start).trim();
    if (demonstrative ? !PUNCT.has(after) : !(atStart || PUNCT.has(before) || PUNCT.has(after))) continue;
    if (quoted.some(([s, e]) => start >= s && start < e)) continue;
    // 引用（「えっとって言った」「えーとと書く」）は残す
    if (text.startsWith('と', ni) || text.startsWith('って', ni)) continue;
    let s = start;
    let e = end;
    if (after === '、') {
      // 後ろの読点と空白も一緒に消す
      e = nextIndex(text, ni + 1);
    } else if (after === '。' && before === '、') {
      // 「〜、えーと。」は前の読点を消して句点を残す
      s = text.lastIndexOf('、', start - 1);
    } else if (!after) {
      // 末尾のつなぎの言葉は、前の読点も消す
      if (before === '、') s = text.lastIndexOf('、', start - 1);
    } else {
      e = ni;
    }
    // 前に消した範囲と重ならないようにする
    s = Math.max(s, edits.at(-1)?.end ?? 0);
    edits.push({ rule: 'fillers', start: s, end: e, before: text.slice(s, e), after: '' });
    i = last;
  }
  if (!edits.length) return { edits };
  // 消すと中身がなくなるなら、何も消さない
  let rest = '';
  let pos = 0;
  for (const e of edits) {
    rest += text.slice(pos, e.start);
    pos = e.end;
  }
  rest += text.slice(pos);
  if (!hasSubstance(rest)) return { edits: [] };
  return { edits };
}
