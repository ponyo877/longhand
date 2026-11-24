/**
 * 整形の出力の検査。文はすべて作った例文である。読みの判定には本物の単語分割（lindera、IPADIC）を使う。
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

describe('parseJaNumber と numbersOf', () => {
  it('漢数字と算用数字の混ざった並びを数にする', () => {
    expect(parseJaNumber('十')).toBe(10);
    expect(parseJaNumber('二十三')).toBe(23);
    expect(parseJaNumber('三千九百八十')).toBe(3980);
    expect(parseJaNumber('一万二千')).toBe(12000);
    expect(parseJaNumber('3万')).toBe(30000);
    expect(parseJaNumber('1万2千')).toBe(12000);
    expect(parseJaNumber('一億二千万')).toBe(120_000_000);
    expect(parseJaNumber('二〇二六')).toBe(2026);
  });

  it('表記が違っても、同じ数は同じ値になる', () => {
    expect(numbersOf('十一月二十八日の十五時から')).toEqual(['11', '28', '15']);
    expect(numbersOf('11月28日の15時から')).toEqual(['11', '28', '15']);
    expect(numbersOf('見積もりは3,980円です')).toEqual(['3980']);
    expect(numbersOf('見積もりは三千九百八十円です')).toEqual(['3980']);
    expect(numbersOf('利用者は３万人を超えました')).toEqual(['30000']);
  });

  it('版の番号と小数は、そのままの形で比べる', () => {
    expect(numbersOf('バージョン2.4.1で12.5%増えた')).toEqual(['2.4.1', '12.5']);
  });

  it('数える言葉が続かない漢数字は、数にしない', () => {
    expect(numbersOf('一緒に一般の百貨店へ行く')).toEqual([]);
  });
});

describe('negationCount', () => {
  it('否定の表現を数える', () => {
    expect(negationCount('それはできません')).toBe(1);
    expect(negationCount('まだ終わっていないので、行かなかった')).toBe(2);
    expect(negationCount('それはできます')).toBe(0);
  });
});

describe('inspectFormatting の塊の分類', () => {
  it('句読点、空白、大文字小文字だけの違いは form', () => {
    expect(kinds('明日の会議は十時からです', '明日の会議は十時からです。')).toEqual(['form']);
    expect(new Set(kinds('githubに上げておきます', 'GitHubに上げておきます。'))).toEqual(new Set(['form']));
  });

  it('同じなら塊は無い', () => {
    const r = inspectFormatting('了解です。', '了解です。', { tokenizer });
    expect(r.hunks).toEqual([]);
    expect(r.violations).toEqual([]);
    expect(r.repaired).toBe('了解です。');
  });

  it('つなぎ言葉の削除は filler', () => {
    expect(kinds('えーと、明日の会議は延期です', '明日の会議は延期です。')).toEqual(['filler', 'form']);
  });

  it('言い直しの前半の削除は repair で、数が減っても問題にしない', () => {
    const r = inspectFormatting('集合は3時、いや4時にします', '集合は4時にします。', { tokenizer });
    expect(r.hunks.map((h) => h.kind)).toEqual(['repair', 'form']);
    expect(r.violations).toEqual([]);
  });

  it('言いかけの繰り返しの削除は repair', () => {
    expect(kinds('これは、これは大事な点です', 'これは大事な点です。')).toContain('repair');
    expect(kinds('これは、これは大事な点です', 'これは大事な点です。')).not.toContain('unsupported');
  });

  it('数の表記だけの違いは number', () => {
    expect(kinds('会議は十時からです。', '会議は10時からです。')).toEqual(['number']);
    expect(kinds('見積もりは三千九百八十円です。', '見積もりは3,980円です。')).toEqual(['number']);
    expect(checks('会議は十時からです。', '会議は10時からです。')).toEqual([]);
  });

  it('辞書や候補にある語への置き換えは evidence', () => {
    expect(kinds('ギットハブに上げておきます。', 'GitHubに上げておきます。', ['GitHub'])).toEqual(['evidence']);
    expect(kinds('グーグルクロームで開きます。', 'Google Chromeで開きます。', ['Google Chrome'])).toEqual(['evidence']);
  });

  it('根拠の語がなくても、音が近い置き換えは sound', () => {
    expect(kinds('ギットハブに上げておきます。', 'GitHubに上げておきます。')).toEqual(['sound']);
  });

  it('読みが同じ置き換え（漢字とかな、同じ読みの漢字）は reading', () => {
    expect(kinds('資料をこうせいに回します。', '資料を校正に回します。')).toEqual(['reading']);
    expect(kinds('資料を公正に回します。', '資料を校正に回します。')).toEqual(['reading']);
  });

  it('助詞 1 字の挿入と削除は particle', () => {
    expect(kinds('資料送っておきます。', '資料を送っておきます。')).toEqual(['particle']);
  });

  it('どれにも当たらない書き換えは unsupported で、整形前に戻す', () => {
    const r = inspectFormatting('明日は雨が降るそうです。', '明日は雪が降るそうです。', { tokenizer });
    expect(r.hunks.map((h) => h.kind)).toEqual(['unsupported']);
    expect(r.repaired).toBe('明日は雨が降るそうです。');
  });

  it('根拠のある塊は残し、根拠のない塊だけを戻す', () => {
    const r = inspectFormatting('えーと、ギットハブに上げたので、あとで見てください', 'GitHubに上げたので、後ほどご確認ください。', { evidence: ['GitHub'], tokenizer });
    expect(r.hunks.map((h) => h.kind)).toContain('evidence');
    expect(r.hunks.map((h) => h.kind)).toContain('unsupported');
    expect(r.repaired.startsWith('GitHubに上げたので、')).toBe(true);
    expect(r.repaired).toContain('見てください');
  });
});

describe('inspectFormatting の問題の検出', () => {
  it('数が変わったら number', () => {
    expect(checks('会議は15時からです。', '会議は16時からです。')).toContain('number');
    expect(checks('会議は15時からです。', '会議は15時から17時までです。')).toContain('number');
  });

  it('言い直しがないのに数が消えたら number', () => {
    expect(checks('参加者は24人で、予算は5万円です。', '参加者は24人です。')).toContain('number');
  });

  it('否定が変わったら negation', () => {
    expect(checks('その機能は使えません。', 'その機能は使えます。')).toContain('negation');
    expect(checks('その機能は使えません。', 'その機能は使えません。')).toEqual([]);
  });

  it('言い直しで否定が変わるのは問題にしない', () => {
    expect(checks('行かない、いや行きます', '行きます。')).not.toContain('negation');
  });

  it('根拠なく足した量が多ければ added、消した量が多ければ removed', () => {
    expect(checks('了解です。', '了解です。資料は明日の朝までに用意しておきます。')).toContain('added');
    expect(checks('資料は明日の朝までに用意しておきます。よろしくお願いします。', 'よろしくお願いします。')).toContain('removed');
  });

  it('出力が整形前の文に由来しなければ provenance', () => {
    expect(checks('今日の天気を教えて', '本日の東京は晴れで、最高気温は18度の見込みです。')).toContain('provenance');
  });

  it('返答のような書き出しは reply', () => {
    expect(checks('明日の予定を整理して', '承知しました。明日の予定を整理します。')).toContain('reply');
    expect(checks('承知しました。明日送ります', '承知しました。明日送ります。')).not.toContain('reply');
  });

  it('ふつうの整形（句読点、つなぎ言葉、英字、数）は問題にならない', () => {
    const r = inspectFormatting('えーと、ギットハブのイシューは十件ありました', 'GitHubのissueは10件ありました。', { evidence: ['GitHub', 'issue'], tokenizer });
    expect(r.violations).toEqual([]);
    expect(r.counts.unsupported).toBe(0);
    expect(r.repaired).toBe('GitHubのissueは10件ありました。');
  });

  it('単語分割がなくても動く（読みの判定だけを飛ばす）', () => {
    const r = inspectFormatting('資料を公正に回します。', '資料を校正に回します。');
    expect(r.hunks.map((h) => h.kind)).toEqual(['unsupported']);
  });
});
