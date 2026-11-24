/**
 * Tests for the formatting output checks. All sentences are made-up examples. Reading checks use the real tokenizer (lindera, IPADIC).
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Tokenizer } from '../textfix/types';
import { createLinderaTokenizer } from '../textfix/tokenizer';
import { inspectFormatting, negationCount, numbersOf, parseJaNumber } from './guards';

const WASM = path.join(process.cwd(), 'node_modules/lindera-wasm-ipadic-web/lindera_wasm_bg.wasm');
let tokenizer: Tokenizer;
beforeAll(async () => {
  tokenizer = await createLinderaTokenizer(fs.readFileSync(WASM));
});

const kinds = (before: string, after: string, evidence: string[] = []) => inspectFormatting(before, after, { evidence, tokenizer }).hunks.map((h) => h.kind);
const checks = (before: string, after: string, evidence: string[] = []) => inspectFormatting(before, after, { evidence, tokenizer }).violations.map((v) => v.check);

describe('parseJaNumber and numbersOf', () => {
  it('parses runs mixing kanji and Arabic numerals', () => {
    expect(parseJaNumber('十')).toBe(10);
    expect(parseJaNumber('二十三')).toBe(23);
    expect(parseJaNumber('三千九百八十')).toBe(3980);
    expect(parseJaNumber('一万二千')).toBe(12000);
    expect(parseJaNumber('3万')).toBe(30000);
    expect(parseJaNumber('1万2千')).toBe(12000);
    expect(parseJaNumber('一億二千万')).toBe(120_000_000);
    expect(parseJaNumber('二〇二六')).toBe(2026);
  });

  it('gives the same value to the same number in different notations', () => {
    expect(numbersOf('十一月二十八日の十五時から')).toEqual(['11', '28', '15']);
    expect(numbersOf('11月28日の15時から')).toEqual(['11', '28', '15']);
    expect(numbersOf('見積もりは3,980円です')).toEqual(['3980']);
    expect(numbersOf('見積もりは三千九百八十円です')).toEqual(['3980']);
    expect(numbersOf('利用者は３万人を超えました')).toEqual(['30000']);
  });

  it('compares version numbers and decimals as written', () => {
    expect(numbersOf('バージョン2.4.1で12.5%増えた')).toEqual(['2.4.1', '12.5']);
  });

  it('does not treat kanji numerals without a following counter as numbers', () => {
    expect(numbersOf('一緒に一般の百貨店へ行く')).toEqual([]);
  });
});

describe('negationCount', () => {
  it('counts negative expressions', () => {
    expect(negationCount('それはできません')).toBe(1);
    expect(negationCount('まだ終わっていないので、行かなかった')).toBe(2);
    expect(negationCount('それはできます')).toBe(0);
  });
});

describe('inspectFormatting hunk classification', () => {
  it('classifies differences only in punctuation, whitespace or case as form', () => {
    expect(kinds('明日の会議は十時からです', '明日の会議は十時からです。')).toEqual(['form']);
    expect(new Set(kinds('githubに上げておきます', 'GitHubに上げておきます。'))).toEqual(new Set(['form']));
  });

  it('finds no hunks in identical text', () => {
    const r = inspectFormatting('了解です。', '了解です。', { tokenizer });
    expect(r.hunks).toEqual([]);
    expect(r.violations).toEqual([]);
    expect(r.repaired).toBe('了解です。');
  });

  it('classifies removed fillers as filler', () => {
    expect(kinds('えーと、明日の会議は延期です', '明日の会議は延期です。')).toEqual(['filler', 'form']);
  });

  it('classifies removing the first half of a self-repair as repair, and allows a dropped number', () => {
    const r = inspectFormatting('集合は3時、いや4時にします', '集合は4時にします。', { tokenizer });
    expect(r.hunks.map((h) => h.kind)).toEqual(['repair', 'form']);
    expect(r.violations).toEqual([]);
  });

  it('classifies removing a repeated false start as repair', () => {
    expect(kinds('これは、これは大事な点です', 'これは大事な点です。')).toContain('repair');
    expect(kinds('これは、これは大事な点です', 'これは大事な点です。')).not.toContain('unsupported');
  });

  it('classifies differences only in number notation as number', () => {
    expect(kinds('会議は十時からです。', '会議は10時からです。')).toEqual(['number']);
    expect(kinds('見積もりは三千九百八十円です。', '見積もりは3,980円です。')).toEqual(['number']);
    expect(checks('会議は十時からです。', '会議は10時からです。')).toEqual([]);
  });

  it('classifies replacement with a dictionary or candidate word as evidence', () => {
    expect(kinds('ギットハブに上げておきます。', 'GitHubに上げておきます。', ['GitHub'])).toEqual(['evidence']);
    expect(kinds('グーグルクロームで開きます。', 'Google Chromeで開きます。', ['Google Chrome'])).toEqual(['evidence']);
  });

  it('classifies a replacement that sounds alike as sound, even without a supporting word', () => {
    expect(kinds('ギットハブに上げておきます。', 'GitHubに上げておきます。')).toEqual(['sound']);
  });

  it('classifies a replacement with the same reading (kanji and kana, kanji with the same reading) as reading', () => {
    expect(kinds('資料をこうせいに回します。', '資料を校正に回します。')).toEqual(['reading']);
    expect(kinds('資料を公正に回します。', '資料を校正に回します。')).toEqual(['reading']);
  });

  it('classifies inserting or removing a one-character particle as particle', () => {
    expect(kinds('資料送っておきます。', '資料を送っておきます。')).toEqual(['particle']);
  });

  it('classifies any other rewrite as unsupported and reverts it', () => {
    const r = inspectFormatting('明日は雨が降るそうです。', '明日は雪が降るそうです。', { tokenizer });
    expect(r.hunks.map((h) => h.kind)).toEqual(['unsupported']);
    expect(r.repaired).toBe('明日は雨が降るそうです。');
  });

  it('keeps supported hunks and reverts only unsupported ones', () => {
    const r = inspectFormatting('えーと、ギットハブに上げたので、あとで見てください', 'GitHubに上げたので、後ほどご確認ください。', { evidence: ['GitHub'], tokenizer });
    expect(r.hunks.map((h) => h.kind)).toContain('evidence');
    expect(r.hunks.map((h) => h.kind)).toContain('unsupported');
    expect(r.repaired.startsWith('GitHubに上げたので、')).toBe(true);
    expect(r.repaired).toContain('見てください');
  });
});

describe('inspectFormatting problem detection', () => {
  it('reports number when a number changes', () => {
    expect(checks('会議は15時からです。', '会議は16時からです。')).toContain('number');
    expect(checks('会議は15時からです。', '会議は15時から17時までです。')).toContain('number');
  });

  it('reports number when a number disappears without a self-repair', () => {
    expect(checks('参加者は24人で、予算は5万円です。', '参加者は24人です。')).toContain('number');
  });

  it('reports negation when negation changes', () => {
    expect(checks('その機能は使えません。', 'その機能は使えます。')).toContain('negation');
    expect(checks('その機能は使えません。', 'その機能は使えません。')).toEqual([]);
  });

  it('allows a negation change caused by a self-repair', () => {
    expect(checks('行かない、いや行きます', '行きます。')).not.toContain('negation');
  });

  it('reports added for too much unsupported addition and removed for too much unsupported removal', () => {
    expect(checks('了解です。', '了解です。資料は明日の朝までに用意しておきます。')).toContain('added');
    expect(checks('資料は明日の朝までに用意しておきます。よろしくお願いします。', 'よろしくお願いします。')).toContain('removed');
  });

  it('reports provenance when the output does not come from the text before formatting', () => {
    expect(checks('今日の天気を教えて', '本日の東京は晴れで、最高気温は18度の見込みです。')).toContain('provenance');
  });

  it('reports reply for an opening that looks like a reply', () => {
    expect(checks('明日の予定を整理して', '承知しました。明日の予定を整理します。')).toContain('reply');
    expect(checks('承知しました。明日送ります', '承知しました。明日送ります。')).not.toContain('reply');
  });

  it('reports nothing for ordinary formatting (punctuation, fillers, Latin letters, numbers)', () => {
    const r = inspectFormatting('えーと、ギットハブのイシューは十件ありました', 'GitHubのissueは10件ありました。', { evidence: ['GitHub', 'issue'], tokenizer });
    expect(r.violations).toEqual([]);
    expect(r.counts.unsupported).toBe(0);
    expect(r.repaired).toBe('GitHubのissueは10件ありました。');
  });

  it('works without a tokenizer (skipping only the reading check)', () => {
    const r = inspectFormatting('資料を公正に回します。', '資料を校正に回します。');
    expect(r.hunks.map((h) => h.kind)).toEqual(['unsupported']);
  });
});
