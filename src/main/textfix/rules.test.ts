/**
 * Tests for the rules that use the tokenizer (b: fillers, c: notation) and for tokenizer position mapping.
 * Uses the real tokenizer (lindera, IPADIC). All sentences are made-up examples.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixText, type FixInput, type Tokenizer } from './index';
import { adaptTokens, createLinderaTokenizer } from './tokenizer';

const WASM = path.join(process.cwd(), 'node_modules/lindera-wasm-ipadic-web/lindera_wasm_bg.wasm');
let tokenizer: Tokenizer;

beforeAll(async () => {
  tokenizer = await createLinderaTokenizer(fs.readFileSync(WASM));
}, 30_000);

const run = (text: string, rules: FixInput['rules'], extra: Partial<FixInput> = {}) => fixText({ text, language: 'ja', rules, tokenizer, ...extra });

describe('tokenizer', () => {
  it('converts UTF-8 byte positions to string indices without drift across whitespace', () => {
    const text = '𠮷野家で  スラックを見る';
    const toks = tokenizer.tokenize(text)!;
    for (const t of toks) expect(text.slice(t.start, t.end)).toBe(t.surface);
    expect(toks.find((t) => t.surface === '見る')?.base).toBe('見る');
  });

  it('uses the surface form as the base form for a token with missing details', () => {
    const toks = adaptTokens('あいう', [{ surface: 'あいう', byte_start: 0, byte_end: 9, details: ['名詞', '一般', '*', '*', '*', '*', '*'] }]);
    expect(toks).toEqual([{ surface: 'あいう', start: 0, end: 3, pos: '名詞', pos1: '一般', base: 'あいう', reading: '' }]);
  });

  it('skips the rules that need tokens when there is no tokenizer', () => {
    const out = fixText({ text: 'えーと、明日行きます', language: 'ja', rules: { fillers: true, notation: true } });
    expect(out.text).toBe('えーと、明日行きます');
    expect(out.skipped).toEqual(['fillers: no-tokenizer', 'notation: no-tokenizer']);
  });
});

describe('rule b (fillers)', () => {
  it.each([
    ['えーと、明日の会議に出ます', '明日の会議に出ます'],
    ['えっと明日行きます', '明日行きます'],
    ['ええと、それは無理です', 'それは無理です'],
    ['えーっと、資料を送ります', '資料を送ります'],
    ['あのー、すみません', 'すみません'],
    ['うーん、難しいですね', '難しいですね'],
    ['んー、どうかな', 'どうかな'],
    ['あの、明日は休みます', '明日は休みます'],
    ['その、なんていうか、困っています', 'なんていうか、困っています'],
    ['明日は、えーと、休みます', '明日は、休みます'],
    ['資料は送りました。えー、次の件です', '資料は送りました。次の件です'],
    ['えーーと、それは', 'それは'],
  ])('%s', (input, expected) => {
    expect(run(input, { fillers: true }).text).toBe(expected);
  });

  it.each([
    'あの人が来た',
    'その件は終わりました',
    '東京え行きます',
    '明日はえーと行きます',
    '「えーと」と書いてください',
    'えーとって言った',
    'えっとと言いかけた',
    'えーと',
    'えーと。',
    'うん、そうです',
    'はい、わかりました',
    'まあ、いいか',
    'なんか食べたい',
  ])('leaves unchanged: %s', (input) => {
    expect(run(input, { fillers: true }).text).toBe(input);
  });

  it('gives the same result when applied twice', () => {
    const once = run('えーと、あのー、明日行きます', { fillers: true }).text;
    expect(once).toBe('明日行きます');
    expect(run(once, { fillers: true }).text).toBe(once);
  });
});

describe('rule c (notation)', () => {
  it.each([
    ['資料を送って下さい', '資料を送ってください'],
    ['教えて頂けますか', '教えていただけますか'],
    ['確認して頂きたいです', '確認していただきたいです'],
    ['よろしくお願い致します', 'よろしくお願いいたします'],
    ['行く事にしました', '行くことにしました'],
    ['子供の時に読んだ', '子供のときに読んだ'],
    ['今の所は大丈夫です', '今のところは大丈夫です'],
    ['念の為に確認します', '念のために確認します'],
    ['そういう訳ではないです', 'そういうわけではないです'],
    ['全ての資料', 'すべての資料'],
    ['既に終わっています', 'すでに終わっています'],
    ['更に追加します', 'さらに追加します'],
    ['是非来てください', 'ぜひ来てください'],
    ['勿論です', 'もちろんです'],
  ])('%s', (input, expected) => {
    expect(run(input, { notation: true }).text).toBe(expected);
  });

  it.each(['水を下さい', 'お菓子を頂く', '時が経つ', '是非を問う', '事件が起きた', '所在地を書く', '翻訳する', '物語を読む', '既存の機能'])('leaves unchanged: %s', (input) => {
    expect(run(input, { notation: true }).text).toBe(input);
  });

  it('gives the same result when applied twice', () => {
    const once = run('既に送って下さい', { notation: true }).text;
    expect(run(once, { notation: true }).text).toBe(once);
  });
});

/** Per-character confidence. 0.95 by default, with only the character ch (first occurrence) set to p */
function conf(text: string, ch?: string, p = 0.95): number[] {
  const out = [...text].map(() => 0.95);
  if (ch) out[text.indexOf(ch)] = p;
  return out;
}

describe('rule d (particles)', () => {
  const d = (text: string, extra: Partial<FixInput> = {}) => run(text, { particles: true }, extra).text;

  it('fixes misspelled fixed expressions even without confidence', () => {
    expect(d('こんにちわ、田中さん')).toBe('こんにちは、田中さん');
    expect(d('こんばんわ')).toBe('こんばんは');
  });

  it('turns 「え」 and 「お」 between a noun and a verb into particles only when confidence is low', () => {
    expect(d('学校え行く', { confidence: conf('学校え行く', 'え', 0.4) })).toBe('学校へ行く');
    expect(d('手紙お書く', { confidence: conf('手紙お書く', 'お', 0.4) })).toBe('手紙を書く');
    expect(d('学校え行く', { confidence: conf('学校え行く', 'え', 0.9) })).toBe('学校え行く');
    expect(d('学校え行く')).toBe('学校え行く');
  });

  it('removes a low-confidence 「を」 between a noun and a verb as added', () => {
    expect(d('資料を送ります', { confidence: conf('資料を送ります', 'を', 0.6) })).toBe('資料送ります');
    // Keep a high-confidence 「を」, a 「を」 without confidence, and any 「を」 when removal is turned off
    expect(d('資料を送ります', { confidence: conf('資料を送ります', 'を', 0.95) })).toBe('資料を送ります');
    expect(d('資料を送ります', { confidence: [0.95, 0.95, null, 0.95, 0.95, 0.95, 0.95] })).toBe('資料を送ります');
    expect(d('資料を送ります')).toBe('資料を送ります');
    expect(d('資料を送ります', { confidence: conf('資料を送ります', 'を', 0.6), dropWo: false })).toBe('資料を送ります');
  });

  it('leaves particles alone outside a noun and a verb, even with low confidence', () => {
    expect(d('何をですか', { confidence: conf('何をですか', 'を', 0.3) })).toBe('何をですか');
    expect(d('資料をお願いします', { confidence: conf('資料をお願いします', 'を', 0.3) })).toBe('資料をお願いします');
    expect(d('東京の、えー', { confidence: conf('東京の、えー', 'え', 0.1) })).toBe('東京の、えー');
  });
});

describe('combined rules', () => {
  it('keeps positions aligned when rules a, b and c run together', () => {
    const out = run('えーと、スラックで送って下さい', { latin: true, fillers: true, notation: true });
    expect(out.text).toBe('Slackで送ってください');
    expect(out.edits.map((e) => e.rule)).toEqual(['fillers', 'latin', 'notation']);
  });
});
