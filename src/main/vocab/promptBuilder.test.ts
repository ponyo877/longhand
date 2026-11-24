import { describe, expect, it } from 'vitest';
import { buildAsrPrompt } from './promptBuilder';

describe('buildAsrPrompt', () => {
  it('list は、語を「、」で並べた 1 文にする', () => {
    expect(buildAsrPrompt(['GitHub', 'Slack', 'Notion'], { style: 'list', importantLast: false })).toBe('GitHub、Slack、Notion。');
  });

  it('大事な語（先頭の語）を、既定では最後に置く', () => {
    expect(buildAsrPrompt(['GitHub', 'Slack', 'Notion'], { style: 'list' })).toBe('Notion、Slack、GitHub。');
    const s = buildAsrPrompt(['GitHub', 'Slack', 'Notion', 'Figma'], { style: 'sentence' });
    expect(s.lastIndexOf('GitHub')).toBeGreaterThan(s.indexOf('Figma'));
    expect(s.endsWith('。')).toBe(true);
  });

  it('sentence と spoken は、句読点のある文に語を埋める', () => {
    const sentence = buildAsrPrompt(['GitHub', 'Slack', 'Notion', 'Figma', 'Docker'], { style: 'sentence', importantLast: false });
    expect(sentence).toBe('GitHub、Slack、Notionを使っています。Figmaの件は、Dockerで確認しました。');
    const spoken = buildAsrPrompt(['GitHub', 'Slack'], { style: 'spoken', importantLast: false });
    expect(spoken).toBe('GitHubとSlackを使ってます。');
    for (const w of ['GitHub', 'Slack', 'Notion', 'Figma', 'Docker']) expect(sentence).toContain(w);
  });

  it('同じ入力からは、同じ文になる', () => {
    const terms = ['Kubernetes', 'Terraform', 'Datadog', 'Sentry', 'Vercel', 'Jira', 'Figma'];
    expect(buildAsrPrompt(terms, { style: 'sentence' })).toBe(buildAsrPrompt(terms, { style: 'sentence' }));
  });

  it('語の数の上限を守り、重複（大文字小文字と全角半角の違い）は 1 つにする', () => {
    expect(buildAsrPrompt(['GitHub', 'github', 'ＧｉｔＨｕｂ', 'Slack', 'Notion'], { style: 'list', maxTerms: 2, importantLast: false })).toBe('GitHub、Slack。');
  });

  it('字数の上限を超えるときは、大事でない語や文から落とす', () => {
    const terms = Array.from({ length: 30 }, (_, i) => `Term${i}`);
    const list = buildAsrPrompt(terms, { style: 'list', maxChars: 40 });
    expect(Array.from(list).length).toBeLessThanOrEqual(40);
    expect(list).toContain('Term0');
    expect(list).not.toContain('Term29');
    const sentence = buildAsrPrompt(terms, { style: 'sentence', maxChars: 60 });
    expect(Array.from(sentence).length).toBeLessThanOrEqual(60);
    expect(sentence).toContain('Term0');
    expect(sentence).not.toContain('Term29');
  });

  it('直前の文脈は最後に置く', () => {
    expect(buildAsrPrompt(['GitHub'], { style: 'list', context: '昨日の続きです。' })).toBe('GitHub。昨日の続きです。');
    expect(buildAsrPrompt([], { style: 'sentence', context: '昨日の続きです。' })).toBe('昨日の続きです。');
  });

  it('語も文脈も無ければ空を返す', () => {
    expect(buildAsrPrompt([], { style: 'sentence' })).toBe('');
    expect(buildAsrPrompt(['  '], { style: 'list' })).toBe('');
  });
});
