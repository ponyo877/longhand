/**
 * Tokenizer for textfix. Initializes lindera (WASM, IPADIC dictionary) from the WASM bytes.
 *
 * - The WASM sits in the packaged app's Resources (forge extraResource) and is read from node_modules during development
 * - Compilation is asynchronous; only unpacking the dictionary (about 120 ms) runs synchronously. Loading happens once, in the background, after startup
 * - The unpacked dictionary adds about 200 MB of memory, so it is loaded only when a rule that needs tokens is on
 * - lindera returns positions in UTF-8 bytes, so they are converted to JavaScript string indices
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

/** UTF-8 byte position → string index */
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

/** Converts lindera tokens to the textfix shape (IPADIC details: part of speech, subcategories 1-3, conjugation type, conjugation form, base form, reading, pronunciation) */
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
      // Release the memory on the WASM side
      t.free?.();
    }
  }
  return out;
}

/** Builds a tokenizer from the WASM bytes. Throws on failure (the caller swallows it and continues without a tokenizer) */
export async function createLinderaTokenizer(wasm: Uint8Array): Promise<Tokenizer> {
  const mod = await import('lindera-wasm-ipadic-web');
  // Compile asynchronously (does not block the main thread). Initialize synchronously from the compiled module
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
