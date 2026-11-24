/**
 * Rule b: removes fillers (えっと, あのー and so on).
 *
 * - Removes only words on a fixed list. IPADIC splits fillers inconsistently (「えっと」 becomes 「えっ」 and 「と」, for example),
 *   so runs of 1-4 tokens aligned to token boundaries are joined and compared with the list
 * - Removes only fillers at the start of the utterance or next to a comma or period. Ones mid-sentence without punctuation around them stay
 * - 「あの」 and 「その」 are removed only when a comma or period follows right away (「あの人」 and 「その件」 stay)
 * - Leaves alone fillers inside corner brackets, before 「と」 or 「って」 (quotation), and cases where removing them would leave nothing
 * - 「うん」, 「はい」, 「まあ」 and 「なんか」 are not on the list (they are often part of the content)
 */
import type { RuleContext, RuleResult } from './index';
import type { FixEdit, Token } from './types';

/** Words to remove (repeated long-vowel marks are collapsed to one before comparing) */
const FILLERS = new Set(['えー', 'えーと', 'えっと', 'ええと', 'えーっと', 'あのー', 'あのう', 'うーん', 'んー']);
/** Words removed only when punctuation follows right away */
const DEMONSTRATIVES = new Set(['あの', 'その']);
const PUNCT = new Set(['、', '。']);
const MAX_TOKENS = 4;

const norm = (s: string) => s.replace(/ー+/g, 'ー');

/** Ranges inside corner brackets */
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
  // An unclosed corner bracket counts as running to the end
  if (stack.length) out.push([stack[0], text.length]);
  return out;
}

/** The previous and next characters, skipping whitespace */
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

/** Finds a run of tokens that starts and ends on token boundaries and matches the list. Returns the index of the last token if found */
function matchFiller(tokens: readonly Token[], i: number): number | null {
  let joined = '';
  let found: number | null = null;
  for (let j = i; j < Math.min(tokens.length, i + MAX_TOKENS); j++) {
    // A gap such as whitespace between tokens means they are not connected
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
    // Keep quotations (「えっとって言った」, 「えーとと書く」)
    if (text.startsWith('と', ni) || text.startsWith('って', ni)) continue;
    let s = start;
    let e = end;
    if (after === '、') {
      // Also remove the following comma and whitespace
      e = nextIndex(text, ni + 1);
    } else if (after === '。' && before === '、') {
      // For 「〜、えーと。」, remove the preceding comma and keep the period
      s = text.lastIndexOf('、', start - 1);
    } else if (!after) {
      // For a filler at the end, also remove the preceding comma
      if (before === '、') s = text.lastIndexOf('、', start - 1);
    } else {
      e = ni;
    }
    // Do not overlap the previously removed range
    s = Math.max(s, edits.at(-1)?.end ?? 0);
    edits.push({ rule: 'fillers', start: s, end: e, before: text.slice(s, e), after: '' });
    i = last;
  }
  if (!edits.length) return { edits };
  // If removing them would leave nothing, remove nothing
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
