import { describe, expect, it, vi } from 'vitest';
import type { AsrResultPayload } from '../../shared/asr-protocol';
import type { TranscribeOptions } from './AsrService';
import { scriptTokens, spliceHinted, transcribeSelective } from './selectiveHints';

describe('scriptTokens', () => {
  it('splits into runs of the same kind of character that join back into the original', () => {
    const text = "このissueはwon't fixでクローズして、READMEに注意書きを足します。";
    const t = scriptTokens(text);
    expect(t.join('')).toBe(text);
    expect(t).toContain('issue');
    expect(t).toContain("won't");
    expect(t).toContain('クローズ');
  });
});

describe('spliceHinted (takes only the places where the hints helped)', () => {
  it('takes places where a dictionary word appears and uses the version without hints for other differences', () => {
    const plain = '見積もりの件、どっかのイメージで確認します。';
    const hinted = '三森の件、Dockerのイメージで確認します。';
    expect(spliceHinted(plain, hinted, ['Docker'])).toEqual({ text: '見積もりの件、Dockerのイメージで確認します。', taken: 1 });
  });

  it('keeps the transcript without hints when no dictionary word appears', () => {
    const plain = 'その件は来週に回しましょう。';
    const hinted = 'その剣は来週に回しましょう。';
    expect(spliceHinted(plain, hinted, ['Docker', '五十嵐'])).toEqual({ text: plain, taken: 0 });
  });

  it('takes kanji dictionary words too', () => {
    expect(spliceHinted('井原氏さんに確認します。', '五十嵐さんに確認します。', ['五十嵐']).text).toBe('五十嵐さんに確認します。');
  });

  it('takes a place written in kana that became a Latin-letter word (even a word not in the dictionary)', () => {
    const r = spliceHinted('クバネティスのクラスターを作ります。', 'Kubernetesのクラスタを作ります。', ['Docker']);
    expect(r.text).toBe('Kubernetesのクラスターを作ります。');
  });

  it('takes places where only the letter case was fixed', () => {
    expect(spliceHinted('githubに上げます。', 'GitHubに上げます。', ['GitHub']).text).toBe('GitHubに上げます。');
  });

  it('does not take differences around a dictionary word that is already right', () => {
    const plain = 'Dockerのビルドを見直します。';
    const hinted = 'Dockerの美瑠度を見直します。';
    expect(spliceHinted(plain, hinted, ['Docker']).text).toBe(plain);
  });

  it('takes dictionary words that contain spaces', () => {
    expect(spliceHinted('プルリクエストを出しました。', 'Pull Requestを出しました。', ['Pull Request']).text).toBe('Pull Requestを出しました。');
  });

  it('handles either transcript being empty', () => {
    expect(spliceHinted('', 'Dockerです。', ['Docker'])).toEqual({ text: 'Dockerです。', taken: 1 });
    expect(spliceHinted('こんにちは。', '', ['Docker'])).toEqual({ text: 'こんにちは。', taken: 0 });
  });
});

describe('transcribeSelective', () => {
  const opts = (hints: string[]): TranscribeOptions => ({ language: 'ja', hints, timeoutMs: 1000 });
  const result = (text: string, extra: Partial<AsrResultPayload> = {}): AsrResultPayload => ({ text, elapsedMs: 10, ...extra });

  it('transcribes without hints first and with hints second, and returns the spliced text and the total time', async () => {
    const run = vi.fn(async (o: TranscribeOptions) =>
      o.hints.length ? result('三森の件、Dockerで確認します。', { hintsGiven: 1, hintsUsed: 1 }) : result('見積もりの件、どっかで確認します。', { tokens: [['見積もり', 0.9]] }),
    );
    const r = await transcribeSelective(run, opts(['Docker']), opts([]));
    expect(run.mock.calls.map((c) => c[0].hints.length)).toEqual([0, 1]);
    expect(r.text).toBe('見積もりの件、Dockerで確認します。');
    expect(r.elapsedMs).toBe(20);
    expect(r.hintsGiven).toBe(1);
    // The confidence is that of the transcript without hints
    expect(r.tokens).toEqual([['見積もり', 0.9]]);
    // A difference that was not taken (見積もり / 三森) remains, so the transcript with hints is attached as another hypothesis
    expect(r.hypotheses).toEqual([{ text: '三森の件、Dockerで確認します。', source: 'hinted', avgLogprob: 0 }]);
  });

  it('attaches no other hypothesis when both transcripts are the same', async () => {
    const run = vi.fn(async () => result('こんにちは。'));
    const r = await transcribeSelective(run, opts(['Docker']), opts([]));
    expect(r.hypotheses).toBeUndefined();
  });

  it('returns the result without hints as it is when there is nothing to take', async () => {
    const run = vi.fn(async (o: TranscribeOptions) => (o.hints.length ? result('その剣は来週です。') : result('その件は来週です。')));
    const r = await transcribeSelective(run, opts(['Docker']), opts([]));
    expect(r.text).toBe('その件は来週です。');
    expect(r.hypotheses?.map((h) => h.text)).toEqual(['その剣は来週です。']);
  });
});
