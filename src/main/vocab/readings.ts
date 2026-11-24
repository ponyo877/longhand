/**
 * Uses the LLM to make katakana readings that speech recognition is likely to write for Latin dictionary words (G4-11).
 * The readings are saved as unconfirmed and used only for match candidates (not for replacement).
 * Only readings the user accepted in the Style page are used for replacement without the LLM.
 */
import { parseJsonObject } from '../format/postprocess';
import type { LlmProvider } from '../llm/types';
import { isKanaOnly } from './kana';

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { word: { type: 'string' }, readings: { type: 'array', items: { type: 'string' } } },
        required: ['word', 'readings'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const SYSTEM = `あなたは日本語の音声認識の辞書係です。
渡された語（主に英字の製品名、サービス名、人名、技術用語）を日本語話者が会話の中で発音したとき、
音声認識がカタカナで書きそうな表記を、語ごとに 1〜3 個挙げてください。
- 一般的な読み方を先に挙げる（例: Grafana → グラファナ）
- 長音の有無など、聞き取りで揺れやすい表記があれば別に挙げる
- 略語はアルファベットの読み（例: CPU → シーピーユー）
- カタカナ以外の文字は使わない
出力は {"items": [{"word": "<渡された語>", "readings": ["<カタカナ>", ...]}]} の JSON だけにしてください。`;

/** Whether to make readings for the word (it contains Latin letters and is not kana only) */
export function needsReading(word: string): boolean {
  return /[A-Za-z]/.test(word) && word.length <= 60;
}

/**
 * Makes katakana readings for words with the LLM. Up to 50 words at a time. Returns an empty object on failure (the caller tries again next time).
 */
export async function generateReadings(words: string[], provider: LlmProvider, timeoutMs = 20000): Promise<Record<string, string[]>> {
  const targets = [...new Set(words.filter(needsReading))].slice(0, 50);
  if (!targets.length) return {};
  const res = await provider.complete({
    system: SYSTEM,
    user: JSON.stringify({ words: targets }),
    jsonSchema: SCHEMA,
    maxOutputTokens: Math.min(4000, 200 + targets.length * 60),
    timeoutMs,
  });
  const parsed = parseJsonObject(res.text);
  const items = Array.isArray(parsed?.items) ? (parsed!.items as { word?: unknown; readings?: unknown }[]) : [];
  const out: Record<string, string[]> = {};
  const wanted = new Set(targets);
  for (const it of items) {
    if (typeof it.word !== 'string' || !wanted.has(it.word) || !Array.isArray(it.readings)) continue;
    const rs = (it.readings as unknown[])
      .filter((r): r is string => typeof r === 'string')
      .map((r) => r.trim())
      .filter((r) => r && isKanaOnly(r.replace(/[・\s]/g, '')))
      .slice(0, 3);
    if (rs.length) out[it.word] = [...new Set(rs)];
  }
  return out;
}
