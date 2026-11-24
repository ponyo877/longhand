/**
 * 書き起こしの後に、辞書の語と照合する（G4-11）。
 * whisper は英字の製品名などをカタカナやひらがなで書くことがある（「ぐらふぁな」）。
 * 辞書の語ごとに読み（音声認識が書きそうなかな表記）を持ち、生テキストのかなの連続と照合して候補を作る。
 * - LLM を使うとき: 候補を整形に渡し、文脈で判断させる（置き換えはしない）
 * - LLM を使わないとき: 利用者が確かめた読みに完全一致した所だけを置き換える
 */
import { countMorae, editDistance, hasKanji, isKanaOnly, matchForm } from './kana';

export interface Reading {
  text: string;
  /** 利用者が確かめた読みか（自分で入力した、自分で直した誤認識の形）。LLM が作った読みは false */
  confirmed: boolean;
}

export interface MatchEntry {
  word: string;
  readings: Reading[];
}

export interface DictionaryMatch {
  /** 生テキストの中の位置（コードポイント単位ではなく、文字列の添字） */
  start: number;
  end: number;
  /** 生テキストで聞き取られていた部分 */
  heard: string;
  /** 辞書の語 */
  word: string;
  /** 読みと完全に一致したか（false なら編集距離 1 の近似一致） */
  exact: boolean;
  /** 一致した読みが、利用者の確かめた読みか */
  confirmed: boolean;
}

/** 整形に渡す候補の上限 */
export const MAX_CANDIDATES = 8;
/** 近似一致を許す読みの最小の拍数 */
const FUZZY_MIN_MORAE = 4;

interface Run {
  start: number;
  /** 照合用の形の 1 文字ごとの、元の文字列での [開始, 終了) */
  map: [number, number][];
  form: string;
}

/** カタカナの連なり（textfix の規則 a が使う） */
export interface KatakanaRun {
  /** 生テキストでの位置 [start, end) */
  start: number;
  end: number;
  text: string;
}

/**
 * 生テキストのカタカナの連なりを取り出す。長音（ー）と中黒（・）は連なりの中にだけ含め、端には置かない。
 * 「クロード・モネ」のような中黒でつないだ名前は、1 つの連なりとして扱う（一部だけを直さないため）
 */
export function katakanaRuns(text: string): KatakanaRun[] {
  const out: KatakanaRun[] = [];
  const re = /[ァ-ヺ][ァ-ヺー・]*/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const body = m[0].replace(/・+$/, '');
    out.push({ start: m.index, end: m.index + body.length, text: body });
  }
  return out;
}

/** 生テキストのかなの連続を取り出し、照合用の形と元の位置の対応を作る */
function kanaRuns(text: string): Run[] {
  const runs: Run[] = [];
  const re = /[ぁ-ゖ゠-ヿー]+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const map: [number, number][] = [];
    let form = '';
    // 1 文字（ヴァなどは 2 文字）ずつ照合用の形にして、位置を覚えておく
    let i = 0;
    const s = m[0];
    while (i < s.length) {
      const two = s.slice(i, i + 2);
      const f2 = /^ヴ[ァィェォ]$/.test(two) ? matchForm(two) : null;
      const len = f2 !== null ? 2 : 1;
      const f = f2 ?? matchForm(s[i]);
      for (let k = 0; k < f.length; k++) map.push([m.index + i, m.index + i + len]);
      form += f;
      i += len;
    }
    if (form) runs.push({ start: m.index, map, form });
  }
  return runs;
}

function overlaps(a: DictionaryMatch, b: DictionaryMatch): boolean {
  return a.start < b.end && b.start < a.end;
}

/** 候補の優先順位: 完全一致、確かめた読み、長い一致 */
function better(a: DictionaryMatch, b: DictionaryMatch): boolean {
  if (a.exact !== b.exact) return a.exact;
  if (a.confirmed !== b.confirmed) return a.confirmed;
  return a.end - a.start > b.end - b.start;
}

/**
 * 生テキストから辞書の語の候補を探す。
 * - かなの読み: 照合用の形（長音、促音、小書き文字、ヴを正規化）で完全一致するか、4 拍以上なら編集距離 1 以内
 * - 漢字の誤認識の形（学習した語の from）: そのまま含まれていれば候補（置き換えには使わない）
 * - 英字の語: 大文字小文字だけが違うか、6 文字以上で綴りが 1 文字違う
 * 語がすでに正しく書かれている所は候補にしない。
 */
export function findDictionaryCandidates(raw: string, entries: MatchEntry[]): DictionaryMatch[] {
  if (!raw.trim() || !entries.length) return [];
  const found: DictionaryMatch[] = [];
  const runs = kanaRuns(raw);
  const lower = raw.toLowerCase();

  for (const e of entries) {
    for (const r of e.readings) {
      const text = r.text.trim();
      if (!text || text === e.word) continue;
      if (isKanaOnly(text.replace(/[・\s]/g, ''))) {
        const form = matchForm(text);
        const morae = countMorae(text);
        if (form.length < 2) continue;
        for (const run of runs) {
          // 完全一致（短い読みは、かなの連続全体と一致したときだけ）
          const whole = morae < 3;
          for (let i = run.form.indexOf(form); i >= 0; i = run.form.indexOf(form, i + 1)) {
            if (whole && (i !== 0 || form.length !== run.form.length)) continue;
            const start = run.map[i][0];
            const end = run.map[i + form.length - 1][1];
            found.push({ start, end, heard: raw.slice(start, end), word: e.word, exact: true, confirmed: r.confirmed });
          }
          // 近似一致
          if (morae >= FUZZY_MIN_MORAE && form.length >= FUZZY_MIN_MORAE) {
            const fa = Array.from(form);
            const ra = Array.from(run.form);
            for (let len = fa.length - 1; len <= fa.length + 1; len++) {
              if (len < 2) continue;
              for (let i = 0; i + len <= ra.length; i++) {
                const win = ra.slice(i, i + len);
                if (win.join('') === form) continue;
                if (editDistance(win, fa) <= 1) {
                  const start = run.map[i][0];
                  const end = run.map[i + len - 1][1];
                  found.push({ start, end, heard: raw.slice(start, end), word: e.word, exact: false, confirmed: r.confirmed });
                }
              }
            }
          }
        }
      } else if (hasKanji(text)) {
        for (let i = raw.indexOf(text); i >= 0; i = raw.indexOf(text, i + 1)) {
          found.push({ start: i, end: i + text.length, heard: text, word: e.word, exact: true, confirmed: false });
        }
      }
    }
    // 英字の語の綴りと大文字小文字
    if (/^[A-Za-z][A-Za-z0-9.+#-]*$/.test(e.word)) {
      const w = e.word.toLowerCase();
      const re = /[A-Za-z][A-Za-z0-9.+#-]*/g;
      for (let m = re.exec(raw); m; m = re.exec(raw)) {
        const tok = m[0];
        if (tok === e.word) continue;
        const tl = tok.toLowerCase();
        if (tl === w) {
          found.push({ start: m.index, end: m.index + tok.length, heard: tok, word: e.word, exact: true, confirmed: /[a-z][A-Z]/.test(e.word) });
        } else if (w.length >= 6 && Math.abs(tl.length - w.length) <= 1 && editDistance(tl, w) <= 1) {
          found.push({ start: m.index, end: m.index + tok.length, heard: tok, word: e.word, exact: false, confirmed: false });
        }
      }
    }
  }

  // 重なる候補は、よいほうを残す
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: DictionaryMatch[] = [];
  for (const m of found) {
    const i = kept.findIndex((k) => overlaps(k, m));
    if (i < 0) kept.push(m);
    else if (better(m, kept[i])) kept[i] = m;
  }
  // 既に正しく書かれている語と同じ所は除く（生テキストにその語がある場合の重複）
  const result = kept.filter((m) => lower.slice(m.start, m.end) !== m.word.toLowerCase() || m.heard !== m.word);
  result.sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.confirmed) - Number(a.confirmed) || a.start - b.start);
  return result.slice(0, MAX_CANDIDATES).sort((a, b) => a.start - b.start);
}

/**
 * LLM を使わないときの置き換え。利用者が確かめた読みに完全一致した所だけを辞書の語にする。
 * 置き換えた数も返す。
 */
export function applyConfirmedMatches(raw: string, matches: DictionaryMatch[]): { text: string; replaced: number } {
  const targets = matches.filter((m) => m.exact && m.confirmed).sort((a, b) => b.start - a.start);
  let text = raw;
  for (const m of targets) text = text.slice(0, m.start) + m.word + text.slice(m.end);
  return { text, replaced: targets.length };
}
