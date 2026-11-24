/**
 * Whisper の語ごとの確信度を、書き起こしの文字ごとの確信度にする。
 *
 * ワーカーは [文字列, 確率] の並びを送る。つなげた文字列は書き起こしとほぼ同じだが、区間の繰り返しの除去や前後の空白の違いがある。
 * 文字の並びを突き合わせ、一致した文字だけに確信度を割り当て、対応が取れない文字は null（確信度なし）にする。
 * 確信度を使う規則は、null の文字を含む所では動かない。
 */

export type Confidence = (number | null)[];

/** 突き合わせる部分の長さの上限（文字数）。超えた部分は確信度なしにする（短い発話が対象なので支障はない） */
const MAX_ALIGN = 2000;

/** from の文字ごとの値を、to の文字に移す。共通の先頭と末尾を除いた残りを、最長共通部分列で突き合わせる */
export function realign(from: string, conf: readonly (number | null)[], to: string): Confidence {
  if (from === to) return [...conf];
  const out: Confidence = Array.from({ length: to.length }, () => null);
  let pre = 0;
  while (pre < from.length && pre < to.length && from[pre] === to[pre]) {
    out[pre] = conf[pre] ?? null;
    pre++;
  }
  let suf = 0;
  while (suf < from.length - pre && suf < to.length - pre && from[from.length - 1 - suf] === to[to.length - 1 - suf]) {
    out[to.length - 1 - suf] = conf[from.length - 1 - suf] ?? null;
    suf++;
  }
  const a = from.slice(pre, from.length - suf);
  const b = to.slice(pre, to.length - suf);
  if (!a.length || !b.length || a.length > MAX_ALIGN || b.length > MAX_ALIGN) return out;
  // 最長共通部分列の表（後ろから）
  const n = a.length;
  const m = b.length;
  const dp = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      out[pre + j] = conf[pre + i] ?? null;
      i++;
      j++;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) i++;
    else j++;
  }
  return out;
}

/** ワーカーの [文字列, 確率] の並びから、text の文字ごとの確信度を作る。並びがなければ null */
export function charConfidence(text: string, tokens: readonly (readonly [string, number])[] | null | undefined): Confidence | null {
  if (!tokens?.length || !text) return null;
  let joined = '';
  const conf: number[] = [];
  for (const [piece, p] of tokens) {
    if (typeof piece !== 'string' || typeof p !== 'number' || !Number.isFinite(p)) return null;
    joined += piece;
    for (let k = 0; k < piece.length; k++) conf.push(Math.max(0, Math.min(1, p)));
  }
  return realign(joined, conf, text);
}

/** 範囲の確信度（最小値）。確信度のない文字を含むか、確信度がなければ null */
export function rangeConfidence(conf: readonly (number | null)[] | null | undefined, start: number, end: number): number | null {
  if (!conf || start >= end) return null;
  let min = 1;
  for (let i = start; i < end; i++) {
    const c = conf[i];
    if (c === null || c === undefined) return null;
    min = Math.min(min, c);
  }
  return min;
}

/** 発話の中身の文字（文字と数字）の確信度の最小値。確信度のある文字がなければ null */
export function minContentConfidence(text: string, conf: readonly (number | null)[] | null | undefined): number | null {
  if (!conf) return null;
  let min: number | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = conf[i];
    if (c === null || c === undefined || !/[\p{L}\p{N}]/u.test(text[i])) continue;
    min = min === null ? c : Math.min(min, c);
  }
  return min;
}

/**
 * 発話の中にこれより確信度の低い字があれば、近道に入れずに LLM に回す（llmReason の low-confidence）。
 *
 * 0.3 未満の字は、ほぼ誤りの印になる。評価の 60 字以下の発話では、0.3 未満の字がある 9 件のうち 8 件で、その字のそばに誤りがあった。
 * 0.3 以上 0.5 未満の字は、誤りの手がかりにならない。この範囲の字だけがある 21 件のうち、誤りのある発話は 10 件（48%）で、
 * 60 字以下の発話の全体（42%）とほとんど変わらず、その字のそばに誤りがあったのは 6 件だけだった。
 * LLM に回すと 1.5〜2 秒遅くなるので、手がかりにならない範囲は回さない（docs/evaluation.md）。
 */
export const LOW_CONFIDENCE = 0.3;
