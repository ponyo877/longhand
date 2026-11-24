import { describe, expect, it, vi } from 'vitest';
import type { AsrResultPayload } from '../../shared/asr-protocol';
import type { TranscribeOptions } from './AsrService';
import { scriptTokens, spliceHinted, transcribeSelective } from './selectiveHints';

describe('scriptTokens', () => {
  it('文字の種類の連続に分け、つなげると元に戻る', () => {
    const text = "このissueはwon't fixでクローズして、READMEに注意書きを足します。";
    const t = scriptTokens(text);
    expect(t.join('')).toBe(text);
    expect(t).toContain('issue');
    expect(t).toContain("won't");
    expect(t).toContain('クローズ');
  });
});

describe('spliceHinted（ヒントが効いた所だけを取り込む）', () => {
  it('辞書の語が現れた所は取り込み、ほかの違いはヒントなしのほうを使う', () => {
    const plain = '見積もりの件、どっかのイメージで確認します。';
    const hinted = '三森の件、Dockerのイメージで確認します。';
    expect(spliceHinted(plain, hinted, ['Docker'])).toEqual({ text: '見積もりの件、Dockerのイメージで確認します。', taken: 1 });
  });

  it('辞書の語が出ていなければ、ヒントなしの書き起こしのままにする', () => {
    const plain = 'その件は来週に回しましょう。';
    const hinted = 'その剣は来週に回しましょう。';
    expect(spliceHinted(plain, hinted, ['Docker', '五十嵐'])).toEqual({ text: plain, taken: 0 });
  });

  it('漢字の辞書の語も取り込む', () => {
    expect(spliceHinted('井原氏さんに確認します。', '五十嵐さんに確認します。', ['五十嵐']).text).toBe('五十嵐さんに確認します。');
  });

  it('かなで書かれていた所が英字の語になったら取り込む（辞書に無い語でも）', () => {
    const r = spliceHinted('クバネティスのクラスターを作ります。', 'Kubernetesのクラスタを作ります。', ['Docker']);
    expect(r.text).toBe('Kubernetesのクラスターを作ります。');
  });

  it('大文字と小文字だけを直した所も取り込む', () => {
    expect(spliceHinted('githubに上げます。', 'GitHubに上げます。', ['GitHub']).text).toBe('GitHubに上げます。');
  });

  it('すでに書けている辞書の語のまわりの違いは取り込まない', () => {
    const plain = 'Dockerのビルドを見直します。';
    const hinted = 'Dockerの美瑠度を見直します。';
    expect(spliceHinted(plain, hinted, ['Docker']).text).toBe(plain);
  });

  it('空白を含む辞書の語も取り込む', () => {
    expect(spliceHinted('プルリクエストを出しました。', 'Pull Requestを出しました。', ['Pull Request']).text).toBe('Pull Requestを出しました。');
  });

  it('どちらかが空のとき', () => {
    expect(spliceHinted('', 'Dockerです。', ['Docker'])).toEqual({ text: 'Dockerです。', taken: 1 });
    expect(spliceHinted('こんにちは。', '', ['Docker'])).toEqual({ text: 'こんにちは。', taken: 0 });
  });
});

describe('transcribeSelective', () => {
  const opts = (hints: string[]): TranscribeOptions => ({ language: 'ja', hints, timeoutMs: 1000 });
  const result = (text: string, extra: Partial<AsrResultPayload> = {}): AsrResultPayload => ({ text, elapsedMs: 10, ...extra });

  it('ヒントなしを先に、ヒントありを後に書き起こし、取り込んだ文と、かかった時間の合計を返す', async () => {
    const run = vi.fn(async (o: TranscribeOptions) =>
      o.hints.length ? result('三森の件、Dockerで確認します。', { hintsGiven: 1, hintsUsed: 1 }) : result('見積もりの件、どっかで確認します。', { tokens: [['見積もり', 0.9]] }),
    );
    const r = await transcribeSelective(run, opts(['Docker']), opts([]));
    expect(run.mock.calls.map((c) => c[0].hints.length)).toEqual([0, 1]);
    expect(r.text).toBe('見積もりの件、Dockerで確認します。');
    expect(r.elapsedMs).toBe(20);
    expect(r.hintsGiven).toBe(1);
    // 確信度は、ヒントなしの書き起こしのもの
    expect(r.tokens).toEqual([['見積もり', 0.9]]);
    // 取り込まなかった食い違い（見積もり / 三森）が残るので、ヒントありの書き起こしを別の仮説として添える
    expect(r.hypotheses).toEqual([{ text: '三森の件、Dockerで確認します。', source: 'hinted', avgLogprob: 0 }]);
  });

  it('2 回の書き起こしが同じなら、別の仮説は添えない', async () => {
    const run = vi.fn(async () => result('こんにちは。'));
    const r = await transcribeSelective(run, opts(['Docker']), opts([]));
    expect(r.hypotheses).toBeUndefined();
  });

  it('取り込む所が無ければ、ヒントなしの結果をそのまま返す', async () => {
    const run = vi.fn(async (o: TranscribeOptions) => (o.hints.length ? result('その剣は来週です。') : result('その件は来週です。')));
    const r = await transcribeSelective(run, opts(['Docker']), opts([]));
    expect(r.text).toBe('その件は来週です。');
    expect(r.hypotheses?.map((h) => h.text)).toEqual(['その剣は来週です。']);
  });
});
