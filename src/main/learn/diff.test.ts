import { describe, expect, it } from 'vitest';
import { diffHunks, extractEditedRegion, extractReplacements, locateEditedRegion } from './diff';

describe('extractEditedRegion', () => {
  it('貼り付けた部分の手直しを取り出す', () => {
    const before = 'こんにちは。\n';
    const afterPaste = 'こんにちは。\nくばねてすのクラスタを更新しました。';
    const final = 'こんにちは。\nKubernetesのクラスタを更新しました。';
    expect(extractEditedRegion(before, afterPaste, final)).toEqual({
      original: 'くばねてすのクラスタを更新しました。',
      edited: 'Kubernetesのクラスタを更新しました。',
    });
  });

  it('変化がなければ null', () => {
    expect(extractEditedRegion('', 'abc', 'abc')).toBeNull();
  });

  it('カーソルの後ろに既存の文があっても範囲を取れる', () => {
    const before = '前の文。後ろの文。';
    const afterPaste = '前の文。新しいすらっくの文。後ろの文。';
    const final = '前の文。新しいSlackの文。後ろの文。';
    const r = extractEditedRegion(before, afterPaste, final)!;
    expect(r.edited).toContain('Slack');
    expect(r.original).toContain('すらっく');
  });

  it('貼り付けより前の既存の文を直しても、学習の対象にしない', () => {
    const before = '担当はさとうです。';
    const afterPaste = '担当はさとうです。明日の会議は10時からです。';
    const final = '担当は佐藤です。明日の会議は10時からです。';
    expect(extractEditedRegion(before, afterPaste, final)).toBeNull();
  });

  it('貼り付けより後ろの既存の文を直しても、学習の対象にしない', () => {
    const before = '前の文。後ろのぶん。';
    const afterPaste = '前の文。新しい文。後ろのぶん。';
    const final = '前の文。新しい文。後ろの文。';
    expect(extractEditedRegion(before, afterPaste, final)).toBeNull();
  });

  it('貼り付けた文の後ろに書き足しただけなら、置き換えは出ない', () => {
    const before = '';
    const afterPaste = 'よろしくお願いします';
    const final = 'よろしくお願いします。田中';
    const r = extractEditedRegion(before, afterPaste, final);
    expect(r === null || extractReplacements(r.original, r.edited).length === 0).toBe(true);
  });
});

describe('extractReplacements', () => {
  it('誤認識の置き換えを語の単位で取り出す', () => {
    const r = extractReplacements('くばねてすのクラスタを更新しました。', 'Kubernetesのクラスタを更新しました。');
    expect(r).toHaveLength(1);
    expect(r[0].to).toBe('Kubernetes');
    expect(r[0].from).toBe('くばねてす');
  });

  it('カタカナ語の置き換え', () => {
    const r = extractReplacements('明日はクリアボイスの件で集まります。', '明日はClearVoiceの件で集まります。');
    expect(r.map((x) => x.to)).toEqual(['ClearVoice']);
  });

  it('人名の漢字の置き換え', () => {
    const r = extractReplacements('日高さんに確認します。', '日鷹さんに確認します。');
    expect(r.map((x) => x.to)).toEqual(['日鷹']);
  });

  it('句読点だけの手直しは無視する', () => {
    expect(extractReplacements('はいわかりました', 'はい、わかりました。')).toEqual([]);
  });

  it('大きな書き換えは推敲とみなして無視する', () => {
    expect(extractReplacements('今日は晴れています。', 'まったく別の文章に書き直した。')).toEqual([]);
  });

  it('追加だけの手直しは無視する', () => {
    expect(extractReplacements('会議は10時からです。', '会議は10時からです。よろしくお願いします。')).toEqual([]);
  });
});

describe('extractReplacements の取りこぼし（G4-04）', () => {
  it('語だけの短い発話でも学習の候補にする', () => {
    const r = extractReplacements('ぐらふぁな', 'Grafana');
    expect(r.map((x) => [x.from, x.to])).toEqual([['ぐらふぁな', 'Grafana']]);
  });

  it('短い文の置き換えも候補にする', () => {
    const r = extractReplacements('でーたどっぐに送る', 'Datadogに送る');
    expect(r.map((x) => [x.from, x.to])).toEqual([['でーたどっぐ', 'Datadog']]);
  });

  it('形に意味がある英字の語は、大文字小文字だけの直しでも候補にする', () => {
    const r = extractReplacements('iphoneで確認します', 'iPhoneで確認します');
    expect(r.map((x) => [x.from, x.to])).toEqual([['iphone', 'iPhone']]);
  });

  it('文頭の大文字化だけの直しは候補にしない', () => {
    expect(extractReplacements('hello everyone', 'Hello everyone')).toEqual([]);
  });

  it('同じ直しが 1 回の手直しに 2 か所あっても 1 件にまとめる', () => {
    const r = extractReplacements('ぐらふぁなとぐらふぁなの設定', 'GrafanaとGrafanaの設定');
    expect(r.map((x) => x.to)).toEqual(['Grafana']);
  });

  it('複数の英単語を 1 語に直したとき、元の語をまとめて取る', () => {
    const r = extractReplacements('Grow fauna dashboard', 'Grafana dashboard');
    expect(r.map((x) => [x.from, x.to])).toEqual([['Grow fauna', 'Grafana']]);
  });

  it('変わっていない語の一部も、元の語と直した語の両方に含める', () => {
    const r = extractReplacements('Post Grace にデータを入れる', 'Postgres にデータを入れる');
    expect(r.map((x) => [x.from, x.to])).toEqual([['Post Grace', 'Postgres']]);
  });

  it('文の前後に書き足した部分は、推敲かどうかの判定に数えない', () => {
    const r = extractReplacements('ぐらふぁなを見て', 'お疲れさまです。Grafanaを見てください。よろしくお願いします。');
    expect(r.map((x) => x.to)).toEqual(['Grafana']);
  });

  it('言い回しを大きく変えた手直しは推敲とみなす', () => {
    expect(extractReplacements('明日の打ち合わせは中止です', '明日のミーティングはなくなりました、すみません')).toEqual([]);
  });
});

describe('locateEditedRegion（G4-02）', () => {
  it('貼り付けた範囲の外も直していたら、範囲の中の手直しだけを取り出す', () => {
    const before = '件名: てすと\n';
    const afterPaste = '件名: てすと\nでーたどっぐで共有します。';
    const final = '件名: テスト\nDatadogで共有します。';
    const r = locateEditedRegion(before, afterPaste, final)!;
    expect(r.original).toBe('でーたどっぐで共有します。');
    expect(r.edited).toBe('Datadogで共有します。');
    expect(r.method).toBe('diff');
  });

  it('貼り付けた文の後ろに書き足した部分は範囲に含めない', () => {
    const r = locateEditedRegion('', 'ぐらふぁなを見てください', 'Grafanaを見てください。日鷹')!;
    expect(r.edited).toBe('Grafanaを見てください');
  });

  it('貼り付けた文の前に書き足した部分は範囲に含めない', () => {
    const r = locateEditedRegion('', 'ぐらふぁなを見てください', 'お疲れさまです。Grafanaを見てください')!;
    expect(r.edited).toBe('Grafanaを見てください');
  });

  it('貼り付けの先頭の語を直したときは、その語を範囲に含める', () => {
    const r = locateEditedRegion('前の文。', '前の文。ぐらふぁなを見て', '前の文。Grafanaを見て')!;
    expect(r.original).toBe('ぐらふぁなを見て');
    expect(r.edited).toBe('Grafanaを見て');
  });

  it('貼り付け直後の読み取りに貼り付けが入っていなくても、貼り付けた文を手がかりに取り出す', () => {
    const r = locateEditedRegion('前の文。', '前の文。', '前の文。Datadogで共有します。', { inserted: 'でーたどっぐで共有します。' })!;
    expect(r.method).toBe('search');
    expect(r.original).toBe('でーたどっぐで共有します。');
    expect(r.edited).toBe('Datadogで共有します。');
  });

  it('アプリが貼り付けの外を書き換えていても、貼り付けた文を探して範囲を決める', () => {
    const before = '下書き 10:00\n';
    const afterPaste = '下書き 10:01\nでーたどっぐで共有します。';
    const final = '下書き 10:02\nDatadogで共有します。';
    const r = locateEditedRegion(before, afterPaste, final, { inserted: 'でーたどっぐで共有します。' })!;
    expect(r.original).toBe('でーたどっぐで共有します。');
    expect(r.edited).toBe('Datadogで共有します。');
  });

  it('貼り付けた範囲を消したら、手直しの文は空になる', () => {
    const r = locateEditedRegion('', 'ぐらふぁなを見て', '')!;
    expect(r.edited).toBe('');
  });
});

describe('diffHunks', () => {
  it('置き換えと挿入の塊を返す', () => {
    const h = diffHunks(Array.from('abcdef'), Array.from('abXdefY'))!;
    expect(h).toEqual([
      { aStart: 2, aEnd: 3, bStart: 2, bEnd: 3 },
      { aStart: 6, aEnd: 6, bStart: 6, bEnd: 7 },
    ]);
  });

  it('変化がなければ空', () => {
    expect(diffHunks(Array.from('同じ'), Array.from('同じ'))).toEqual([]);
  });
});
