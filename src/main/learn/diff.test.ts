import { describe, expect, it } from 'vitest';
import { diffHunks, extractEditedRegion, extractReplacements, locateEditedRegion } from './diff';

describe('extractEditedRegion', () => {
  it('extracts corrections to the pasted part', () => {
    const before = 'こんにちは。\n';
    const afterPaste = 'こんにちは。\nくばねてすのクラスタを更新しました。';
    const final = 'こんにちは。\nKubernetesのクラスタを更新しました。';
    expect(extractEditedRegion(before, afterPaste, final)).toEqual({
      original: 'くばねてすのクラスタを更新しました。',
      edited: 'Kubernetesのクラスタを更新しました。',
    });
  });

  it('returns null without changes', () => {
    expect(extractEditedRegion('', 'abc', 'abc')).toBeNull();
  });

  it('finds the range even with existing text after the cursor', () => {
    const before = '前の文。後ろの文。';
    const afterPaste = '前の文。新しいすらっくの文。後ろの文。';
    const final = '前の文。新しいSlackの文。後ろの文。';
    const r = extractEditedRegion(before, afterPaste, final)!;
    expect(r.edited).toContain('Slack');
    expect(r.original).toContain('すらっく');
  });

  it('ignores corrections to existing text before the paste', () => {
    const before = '担当はさとうです。';
    const afterPaste = '担当はさとうです。明日の会議は10時からです。';
    const final = '担当は佐藤です。明日の会議は10時からです。';
    expect(extractEditedRegion(before, afterPaste, final)).toBeNull();
  });

  it('ignores corrections to existing text after the paste', () => {
    const before = '前の文。後ろのぶん。';
    const afterPaste = '前の文。新しい文。後ろのぶん。';
    const final = '前の文。新しい文。後ろの文。';
    expect(extractEditedRegion(before, afterPaste, final)).toBeNull();
  });

  it('yields no replacements when text was only added after the pasted text', () => {
    const before = '';
    const afterPaste = 'よろしくお願いします';
    const final = 'よろしくお願いします。田中';
    const r = extractEditedRegion(before, afterPaste, final);
    expect(r === null || extractReplacements(r.original, r.edited).length === 0).toBe(true);
  });
});

describe('extractReplacements', () => {
  it('extracts replacements of misrecognized words as whole words', () => {
    const r = extractReplacements('くばねてすのクラスタを更新しました。', 'Kubernetesのクラスタを更新しました。');
    expect(r).toHaveLength(1);
    expect(r[0].to).toBe('Kubernetes');
    expect(r[0].from).toBe('くばねてす');
  });

  it('extracts a replaced katakana word', () => {
    const r = extractReplacements('明日はクリアボイスの件で集まります。', '明日はClearVoiceの件で集まります。');
    expect(r.map((x) => x.to)).toEqual(['ClearVoice']);
  });

  it('extracts a replaced kanji personal name', () => {
    const r = extractReplacements('日高さんに確認します。', '日鷹さんに確認します。');
    expect(r.map((x) => x.to)).toEqual(['日鷹']);
  });

  it('ignores punctuation-only corrections', () => {
    expect(extractReplacements('はいわかりました', 'はい、わかりました。')).toEqual([]);
  });

  it('ignores large rewrites as rewriting', () => {
    expect(extractReplacements('今日は晴れています。', 'まったく別の文章に書き直した。')).toEqual([]);
  });

  it('ignores corrections that only add text', () => {
    expect(extractReplacements('会議は10時からです。', '会議は10時からです。よろしくお願いします。')).toEqual([]);
  });
});

describe('extractReplacements misses (G4-04)', () => {
  it('makes a candidate even from a short single-word utterance', () => {
    const r = extractReplacements('ぐらふぁな', 'Grafana');
    expect(r.map((x) => [x.from, x.to])).toEqual([['ぐらふぁな', 'Grafana']]);
  });

  it('makes a candidate from a replacement in a short sentence', () => {
    const r = extractReplacements('でーたどっぐに送る', 'Datadogに送る');
    expect(r.map((x) => [x.from, x.to])).toEqual([['でーたどっぐ', 'Datadog']]);
  });

  it('makes a candidate from a case-only fix to a Latin word whose case carries meaning', () => {
    const r = extractReplacements('iphoneで確認します', 'iPhoneで確認します');
    expect(r.map((x) => [x.from, x.to])).toEqual([['iphone', 'iPhone']]);
  });

  it('makes no candidate from sentence-start capitalization alone', () => {
    expect(extractReplacements('hello everyone', 'Hello everyone')).toEqual([]);
  });

  it('merges the same fix appearing twice in one correction into one', () => {
    const r = extractReplacements('ぐらふぁなとぐらふぁなの設定', 'GrafanaとGrafanaの設定');
    expect(r.map((x) => x.to)).toEqual(['Grafana']);
  });

  it('takes the original words together when several English words become one', () => {
    const r = extractReplacements('Grow fauna dashboard', 'Grafana dashboard');
    expect(r.map((x) => [x.from, x.to])).toEqual([['Grow fauna', 'Grafana']]);
  });

  it('includes the unchanged part of a word in both the original and the corrected word', () => {
    const r = extractReplacements('Post Grace にデータを入れる', 'Postgres にデータを入れる');
    expect(r.map((x) => [x.from, x.to])).toEqual([['Post Grace', 'Postgres']]);
  });

  it('does not count text added before or after when judging rewriting', () => {
    const r = extractReplacements('ぐらふぁなを見て', 'お疲れさまです。Grafanaを見てください。よろしくお願いします。');
    expect(r.map((x) => x.to)).toEqual(['Grafana']);
  });

  it('treats a correction that changes the wording a lot as rewriting', () => {
    expect(extractReplacements('明日の打ち合わせは中止です', '明日のミーティングはなくなりました、すみません')).toEqual([]);
  });
});

describe('locateEditedRegion (G4-02)', () => {
  it('extracts only the corrections inside the pasted range when text outside it was also edited', () => {
    const before = '件名: てすと\n';
    const afterPaste = '件名: てすと\nでーたどっぐで共有します。';
    const final = '件名: テスト\nDatadogで共有します。';
    const r = locateEditedRegion(before, afterPaste, final)!;
    expect(r.original).toBe('でーたどっぐで共有します。');
    expect(r.edited).toBe('Datadogで共有します。');
    expect(r.method).toBe('diff');
  });

  it('leaves text added after the pasted text out of the range', () => {
    const r = locateEditedRegion('', 'ぐらふぁなを見てください', 'Grafanaを見てください。日鷹')!;
    expect(r.edited).toBe('Grafanaを見てください');
  });

  it('leaves text added before the pasted text out of the range', () => {
    const r = locateEditedRegion('', 'ぐらふぁなを見てください', 'お疲れさまです。Grafanaを見てください')!;
    expect(r.edited).toBe('Grafanaを見てください');
  });

  it('includes the first word of the paste in the range when it was corrected', () => {
    const r = locateEditedRegion('前の文。', '前の文。ぐらふぁなを見て', '前の文。Grafanaを見て')!;
    expect(r.original).toBe('ぐらふぁなを見て');
    expect(r.edited).toBe('Grafanaを見て');
  });

  it('uses the pasted text as a clue when the reading right after the paste does not include it', () => {
    const r = locateEditedRegion('前の文。', '前の文。', '前の文。Datadogで共有します。', { inserted: 'でーたどっぐで共有します。' })!;
    expect(r.method).toBe('search');
    expect(r.original).toBe('でーたどっぐで共有します。');
    expect(r.edited).toBe('Datadogで共有します。');
  });

  it('finds the range by searching for the pasted text when the app rewrote text outside the paste', () => {
    const before = '下書き 10:00\n';
    const afterPaste = '下書き 10:01\nでーたどっぐで共有します。';
    const final = '下書き 10:02\nDatadogで共有します。';
    const r = locateEditedRegion(before, afterPaste, final, { inserted: 'でーたどっぐで共有します。' })!;
    expect(r.original).toBe('でーたどっぐで共有します。');
    expect(r.edited).toBe('Datadogで共有します。');
  });

  it('gives empty corrected text when the pasted range was deleted', () => {
    const r = locateEditedRegion('', 'ぐらふぁなを見て', '')!;
    expect(r.edited).toBe('');
  });
});

describe('diffHunks', () => {
  it('returns replacement and insertion hunks', () => {
    const h = diffHunks(Array.from('abcdef'), Array.from('abXdefY'))!;
    expect(h).toEqual([
      { aStart: 2, aEnd: 3, bStart: 2, bEnd: 3 },
      { aStart: 6, aEnd: 6, bStart: 6, bEnd: 7 },
    ]);
  });

  it('returns nothing without changes', () => {
    expect(diffHunks(Array.from('同じ'), Array.from('同じ'))).toEqual([]);
  });
});
