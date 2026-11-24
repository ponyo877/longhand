import { describe, expect, it } from 'vitest';
import { extractCandidates, textsFromFile } from './dictCandidates';

const words = (texts: string[], existing: string[] = []) => extractCandidates(texts, { existing }).map((c) => c.word);

describe('extractCandidates', () => {
  it('日本語の文に混ざった英字の語を、回数の多い順に返す', () => {
    const r = extractCandidates(['Grafana のダッシュボードを見てください。', 'まず Grafana を開いて、次に Sentry を確認します。']);
    expect(r.map((c) => [c.word, c.count])).toEqual([
      ['Grafana', 2],
      ['Sentry', 1],
    ]);
    expect(r[0].sample).toContain('Grafana のダッシュボード');
  });

  it('すでに辞書にある語は、大文字小文字や全角半角が違っても外す', () => {
    expect(words(['ＧｉｔＨｕｂ と Notion を使います'], ['github'])).toEqual(['Notion']);
  });

  it('大文字と小文字だけが違う書き方は 1 つにまとめ、いちばん多い書き方を使う', () => {
    const r = extractCandidates(['github に上げる', 'GitHub に上げる', 'GitHub を見る']);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ word: 'GitHub', count: 3 });
  });

  it('同じ回数なら、大文字の多い書き方を使う', () => {
    expect(words(['typescript で書く', 'TypeScript で書く'])).toEqual(['TypeScript']);
  });

  it('ありふれた英語の語、1 字の語、数に単位が付いただけのものは外す', () => {
    expect(words(['OK です。the と and は要りません。A 案で 10ms、24GB、3D、5G です'])).toEqual(['3D', '5G']);
  });

  it('記号を含む名前を 1 語として拾う', () => {
    expect(words(['Node.js と C++ と C# と GPT-5 と large-v3-turbo を試す']).sort()).toEqual(['C#', 'C++', 'GPT-5', 'Node.js', 'large-v3-turbo'].sort());
  });

  it('URL とメールアドレスの中の語は拾わない', () => {
    expect(words(['詳しくは https://example.com/docs/setup を見るか、someone@example.org まで。Vercel に置きます'])).toEqual(['Vercel']);
  });

  it('縮約形（アポストロフィを含む語）は拾わない', () => {
    expect(words(["don't と it's は外す"])).toEqual([]);
  });

  it('大文字で始まる語の並びは、2 回以上出てきたら、ひとまとまりの候補にする', () => {
    const r = extractCandidates(['Google Chrome で開く', 'Google Chrome を閉じる', 'Chrome の設定']);
    expect(r.map((c) => [c.word, c.count])).toEqual(
      [
        ['Chrome', 1],
        ['Google Chrome', 2],
      ].sort((a, b) => (b[1] as number) - (a[1] as number)),
    );
  });

  it('1 回しか出てこない並びは、1 語ずつ数える', () => {
    expect(words(['Slack Notion Figma を使っています']).sort()).toEqual(['Figma', 'Notion', 'Slack']);
  });

  it('日本語をはさんだ語は、ひとまとまりにしない', () => {
    expect(words(['Slack と Notion', 'Slack と Notion']).sort()).toEqual(['Notion', 'Slack']);
  });

  it('英語の文からは、名前らしい語だけを拾う', () => {
    const r = words(['Please open the dashboard in Grafana and check the latest deploy on GitHub. Deploys are slow today.']);
    expect(r.sort()).toEqual(['GitHub', 'Grafana']);
  });

  it('英語の文の中でも、数字や途中の大文字がある語は文頭でも拾う', () => {
    expect(words(['iPhone users should update to the latest version of the app now.'])).toEqual(['iPhone']);
  });

  it('上限の数までを返す', () => {
    const texts = Array.from({ length: 30 }, (_, i) => `Tool${String.fromCharCode(65 + (i % 26))}${i} を使う`);
    expect(extractCandidates(texts, { limit: 10 })).toHaveLength(10);
  });

  it('長すぎる語は外す', () => {
    expect(words([`${'Ab'.repeat(40)} と Longhand`])).toEqual(['Longhand']);
  });

  it('前後の文は、英字の語の途中で切らない', () => {
    const r = extractCandidates(['まず Grafana を開いて、次に Sentry の通知を見て、Kubernetes の設定を直します。']);
    const sample = r.find((c) => c.word === 'Sentry')?.sample ?? '';
    expect(sample).toContain('次に Sentry の通知');
    expect(sample).not.toMatch(/…[A-Za-z]/);
    expect(sample).not.toMatch(/[A-Za-z]…/);
  });

  it('空の入力では空を返す', () => {
    expect(extractCandidates([])).toEqual([]);
    expect(extractCandidates(['日本語だけの文です。'])).toEqual([]);
  });
});

describe('textsFromFile', () => {
  it('ふつうのテキストはそのまま返す', () => {
    expect(textsFromFile('\uFEFFGrafana を開く\nSentry を見る')).toEqual(['Grafana を開く\nSentry を見る']);
  });

  it('JSON からは、文章らしい値だけを取り出す', () => {
    const json = JSON.stringify({ items: [{ id: 'a1b2c3', kind: 'dictation', audio: 'audio/a1b2c3.wav', text: 'Grafana を開く' }], note: 'open the dashboard' });
    expect(textsFromFile(json)).toEqual(['Grafana を開く', 'open the dashboard']);
  });

  it('JSON Lines を 1 行ずつ読む', () => {
    const jsonl = [
      { id: 'x1', text: 'Sentry を見る' },
      { id: 'x2', text: 'Vercel に置く' },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n');
    expect(textsFromFile(`${jsonl}\n`)).toEqual(['Sentry を見る', 'Vercel に置く']);
    expect(extractCandidates(textsFromFile(jsonl)).map((c) => c.word)).toEqual(['Sentry', 'Vercel']);
  });

  it('JSON として読めないときは、テキストとして読む', () => {
    expect(textsFromFile('[メモ] Grafana を開く')).toEqual(['[メモ] Grafana を開く']);
  });
});
