import { describe, expect, it } from 'vitest';
import { extractScreenTerms } from './screenTerms';

describe('extractScreenTerms', () => {
  it('日本語の文に混ざった、名前らしい英字の語を拾う', () => {
    const terms = extractScreenTerms(['昨日 Grafana のダッシュボードを見たら、PostgreSQL の接続が増えていました。', 'Grafana の件、あとで見ます']);
    expect(terms).toEqual(['Grafana', 'PostgreSQL']);
  });

  it('小文字だけの語（コマンドや変数の名前）は拾わない', () => {
    expect(extractScreenTerms(['npm run build のあとで git status を見て、kubectl で確認する。TypeScript は通った'])).toEqual(['TypeScript']);
  });

  it('メニューやボタンの英語は拾わない', () => {
    expect(extractScreenTerms(['File Edit View Window Help', '下書きを Save して Send する前に、Figma を開く'])).toEqual(['Figma']);
  });

  it('すでに辞書にある語は拾わない', () => {
    expect(extractScreenTerms(['Slack と Notion と Linear を使う'], { existing: ['slack', 'Notion'] })).toEqual(['Linear']);
  });

  it('出てきた回数の多い順に、上限までを返す', () => {
    const text = 'Vercel Vercel Vercel と Sentry Sentry と Datadog を見る';
    expect(extractScreenTerms([text], { limit: 2 })).toEqual(['Vercel', 'Sentry']);
  });

  it('頭字語と、数字の混ざった語も拾う', () => {
    expect(extractScreenTerms(['AWS の S3 と EC2、それに GPT-5 を使う']).sort()).toEqual(['AWS', 'EC2', 'GPT-5', 'S3']);
  });

  it('空の入力では空を返す', () => {
    expect(extractScreenTerms([])).toEqual([]);
    expect(extractScreenTerms([undefined, '', '日本語だけの文です。'])).toEqual([]);
  });
});
