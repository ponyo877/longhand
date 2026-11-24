/**
 * textfix の単語分割。lindera（WASM、辞書は IPADIC）を、WASM のバイト列から初期化する。
 *
 * - WASM は配布パッケージの Resources に置き（forge の extraResource）、開発中は node_modules から読む
 * - コンパイルは非同期で行い、辞書の展開（約 120ms）だけが同期で走る。読み込みは起動の後に裏で 1 回だけ行う
 * - 展開した辞書でメモリが約 200MB 増えるので、単語分割を使う規則がオンのときだけ読み込む
 * - 位置は lindera が UTF-8 のバイトで返すので、JavaScript の文字列の添字に直す
 */
import type { Token, Tokenizer } from './types';

interface LinderaToken {
  surface: string;
  byte_start: number;
  byte_end: number;
  details: string[];
  free?: () => void;
}

interface LinderaTokenizer {
  tokenize(text: string): LinderaToken[];
}

/** UTF-8 のバイト位置 → 文字列の添字 */
function byteToIndex(text: string): Int32Array {
  const map = new Int32Array(text.length * 4 + 1);
  let b = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const units = cp > 0xffff ? 2 : 1;
    const bytes = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    for (let k = 0; k < bytes; k++) map[b + k] = i;
    b += bytes;
    i += units;
  }
  map[b] = text.length;
  return map.subarray(0, b + 1);
}

const field = (d: string[], i: number) => (d[i] && d[i] !== '*' ? d[i] : '');

/** lindera のトークンを textfix の形にする（IPADIC の詳細は 品詞, 細分類1〜3, 活用型, 活用形, 基本形, 読み, 発音） */
export function adaptTokens(text: string, raw: readonly LinderaToken[]): Token[] {
  const map = byteToIndex(text);
  const out: Token[] = [];
  for (const t of raw) {
    try {
      const d = t.details ?? [];
      const start = map[Math.min(t.byte_start, map.length - 1)];
      const end = map[Math.min(t.byte_end, map.length - 1)];
      out.push({
        surface: t.surface,
        start,
        end,
        pos: field(d, 0),
        pos1: field(d, 1),
        base: field(d, 6) || t.surface,
        reading: field(d, 7),
      });
    } finally {
      // WASM 側のメモリを返す
      t.free?.();
    }
  }
  return out;
}

/** WASM のバイト列から単語分割を作る。失敗したら例外を投げる（呼び出し側で握りつぶし、単語分割なしで続ける） */
export async function createLinderaTokenizer(wasm: Uint8Array): Promise<Tokenizer> {
  const mod = await import('lindera-wasm-ipadic-web');
  // コンパイルは非同期（メインスレッドを止めない）。初期化はコンパイル済みのモジュールから同期で行う
  const compiled = await WebAssembly.compile(wasm as Uint8Array<ArrayBuffer>);
  mod.initSync({ module: compiled });
  const builder = new mod.TokenizerBuilder();
  builder.setDictionary('embedded://ipadic');
  builder.setMode('normal');
  const lindera = builder.build() as unknown as LinderaTokenizer;
  return {
    tokenize(text: string): Token[] | null {
      if (!text) return [];
      return adaptTokens(text, lindera.tokenize(text));
    },
  };
}
