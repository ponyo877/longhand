import { describe, expect, it } from 'vitest';
import { extractScreenTerms } from './screenTerms';

describe('extractScreenTerms', () => {
  it('picks up name-like Latin words mixed into Japanese text', () => {
    const terms = extractScreenTerms(['昨日 Grafana のダッシュボードを見たら、PostgreSQL の接続が増えていました。', 'Grafana の件、あとで見ます']);
    expect(terms).toEqual(['Grafana', 'PostgreSQL']);
  });

  it('skips all-lowercase words (command and variable names)', () => {
    expect(extractScreenTerms(['npm run build のあとで git status を見て、kubectl で確認する。TypeScript は通った'])).toEqual(['TypeScript']);
  });

  it('skips English menu and button words', () => {
    expect(extractScreenTerms(['File Edit View Window Help', '下書きを Save して Send する前に、Figma を開く'])).toEqual(['Figma']);
  });

  it('skips words already in the dictionary', () => {
    expect(extractScreenTerms(['Slack と Notion と Linear を使う'], { existing: ['slack', 'Notion'] })).toEqual(['Linear']);
  });

  it('returns words up to the limit, most frequent first', () => {
    const text = 'Vercel Vercel Vercel と Sentry Sentry と Datadog を見る';
    expect(extractScreenTerms([text], { limit: 2 })).toEqual(['Vercel', 'Sentry']);
  });

  it('also picks up acronyms and words with digits', () => {
    expect(extractScreenTerms(['AWS の S3 と EC2、それに GPT-5 を使う']).sort()).toEqual(['AWS', 'EC2', 'GPT-5', 'S3']);
  });

  it('returns nothing for empty input', () => {
    expect(extractScreenTerms([])).toEqual([]);
    expect(extractScreenTerms([undefined, '', '日本語だけの文です。'])).toEqual([]);
  });
});
