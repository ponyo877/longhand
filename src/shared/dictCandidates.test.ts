import { describe, expect, it } from 'vitest';
import { extractCandidates, textsFromFile } from './dictCandidates';

const words = (texts: string[], existing: string[] = []) => extractCandidates(texts, { existing }).map((c) => c.word);

describe('extractCandidates', () => {
  it('returns Latin words mixed into Japanese text, most frequent first', () => {
    const r = extractCandidates(['Grafana のダッシュボードを見てください。', 'まず Grafana を開いて、次に Sentry を確認します。']);
    expect(r.map((c) => [c.word, c.count])).toEqual([
      ['Grafana', 2],
      ['Sentry', 1],
    ]);
    expect(r[0].sample).toContain('Grafana のダッシュボード');
  });

  it('leaves out words already in the dictionary, even with different case or width', () => {
    expect(words(['ＧｉｔＨｕｂ と Notion を使います'], ['github'])).toEqual(['Notion']);
  });

  it('merges spellings that differ only in case and uses the most frequent one', () => {
    const r = extractCandidates(['github に上げる', 'GitHub に上げる', 'GitHub を見る']);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ word: 'GitHub', count: 3 });
  });

  it('uses the spelling with more uppercase letters on a tie', () => {
    expect(words(['typescript で書く', 'TypeScript で書く'])).toEqual(['TypeScript']);
  });

  it('leaves out common English words, one-letter words and numbers with only a unit', () => {
    expect(words(['OK です。the と and は要りません。A 案で 10ms、24GB、3D、5G です'])).toEqual(['3D', '5G']);
  });

  it('picks names with symbols as one word', () => {
    expect(words(['Node.js と C++ と C# と GPT-5 と large-v3-turbo を試す']).sort()).toEqual(['C#', 'C++', 'GPT-5', 'Node.js', 'large-v3-turbo'].sort());
  });

  it('picks no words inside URLs and email addresses', () => {
    expect(words(['詳しくは https://example.com/docs/setup を見るか、someone@example.org まで。Vercel に置きます'])).toEqual(['Vercel']);
  });

  it('picks no contractions (words with an apostrophe)', () => {
    expect(words(["don't と it's は外す"])).toEqual([]);
  });

  it('makes a run of capitalized words one candidate when it appears twice or more', () => {
    const r = extractCandidates(['Google Chrome で開く', 'Google Chrome を閉じる', 'Chrome の設定']);
    expect(r.map((c) => [c.word, c.count])).toEqual(
      [
        ['Chrome', 1],
        ['Google Chrome', 2],
      ].sort((a, b) => (b[1] as number) - (a[1] as number)),
    );
  });

  it('counts a run that appears only once word by word', () => {
    expect(words(['Slack Notion Figma を使っています']).sort()).toEqual(['Figma', 'Notion', 'Slack']);
  });

  it('does not join words with Japanese between them', () => {
    expect(words(['Slack と Notion', 'Slack と Notion']).sort()).toEqual(['Notion', 'Slack']);
  });

  it('picks only name-like words from English prose', () => {
    const r = words(['Please open the dashboard in Grafana and check the latest deploy on GitHub. Deploys are slow today.']);
    expect(r.sort()).toEqual(['GitHub', 'Grafana']);
  });

  it('picks words with digits or inner uppercase letters even at the start of an English sentence', () => {
    expect(words(['iPhone users should update to the latest version of the app now.'])).toEqual(['iPhone']);
  });

  it('returns up to the limit', () => {
    const texts = Array.from({ length: 30 }, (_, i) => `Tool${String.fromCharCode(65 + (i % 26))}${i} を使う`);
    expect(extractCandidates(texts, { limit: 10 })).toHaveLength(10);
  });

  it('leaves out words that are too long', () => {
    expect(words([`${'Ab'.repeat(40)} と Longhand`])).toEqual(['Longhand']);
  });

  it('does not cut the sample in the middle of a Latin word', () => {
    const r = extractCandidates(['まず Grafana を開いて、次に Sentry の通知を見て、Kubernetes の設定を直します。']);
    const sample = r.find((c) => c.word === 'Sentry')?.sample ?? '';
    expect(sample).toContain('次に Sentry の通知');
    expect(sample).not.toMatch(/…[A-Za-z]/);
    expect(sample).not.toMatch(/[A-Za-z]…/);
  });

  it('returns nothing for empty input', () => {
    expect(extractCandidates([])).toEqual([]);
    expect(extractCandidates(['日本語だけの文です。'])).toEqual([]);
  });
});

describe('textsFromFile', () => {
  it('returns plain text as is', () => {
    expect(textsFromFile('\uFEFFGrafana を開く\nSentry を見る')).toEqual(['Grafana を開く\nSentry を見る']);
  });

  it('takes only prose-like values from JSON', () => {
    const json = JSON.stringify({ items: [{ id: 'a1b2c3', kind: 'dictation', audio: 'audio/a1b2c3.wav', text: 'Grafana を開く' }], note: 'open the dashboard' });
    expect(textsFromFile(json)).toEqual(['Grafana を開く', 'open the dashboard']);
  });

  it('reads JSON Lines line by line', () => {
    const jsonl = [
      { id: 'x1', text: 'Sentry を見る' },
      { id: 'x2', text: 'Vercel に置く' },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n');
    expect(textsFromFile(`${jsonl}\n`)).toEqual(['Sentry を見る', 'Vercel に置く']);
    expect(extractCandidates(textsFromFile(jsonl)).map((c) => c.word)).toEqual(['Sentry', 'Vercel']);
  });

  it('reads text that is not valid JSON as text', () => {
    expect(textsFromFile('[メモ] Grafana を開く')).toEqual(['[メモ] Grafana を開く']);
  });
});
