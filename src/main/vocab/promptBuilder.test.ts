import { describe, expect, it } from 'vitest';
import { buildAsrPrompt } from './promptBuilder';

describe('buildAsrPrompt', () => {
  it('makes list one sentence of words separated by 「、」', () => {
    expect(buildAsrPrompt(['GitHub', 'Slack', 'Notion'], { style: 'list', importantLast: false })).toBe('GitHub、Slack、Notion。');
  });

  it('puts important words (the first ones) last by default', () => {
    expect(buildAsrPrompt(['GitHub', 'Slack', 'Notion'], { style: 'list' })).toBe('Notion、Slack、GitHub。');
    const s = buildAsrPrompt(['GitHub', 'Slack', 'Notion', 'Figma'], { style: 'sentence' });
    expect(s.lastIndexOf('GitHub')).toBeGreaterThan(s.indexOf('Figma'));
    expect(s.endsWith('。')).toBe(true);
  });

  it('embeds words in punctuated sentences for sentence and spoken', () => {
    const sentence = buildAsrPrompt(['GitHub', 'Slack', 'Notion', 'Figma', 'Docker'], { style: 'sentence', importantLast: false });
    expect(sentence).toBe('GitHub、Slack、Notionを使っています。Figmaの件は、Dockerで確認しました。');
    const spoken = buildAsrPrompt(['GitHub', 'Slack'], { style: 'spoken', importantLast: false });
    expect(spoken).toBe('GitHubとSlackを使ってます。');
    for (const w of ['GitHub', 'Slack', 'Notion', 'Figma', 'Docker']) expect(sentence).toContain(w);
  });

  it('gives the same text for the same input', () => {
    const terms = ['Kubernetes', 'Terraform', 'Datadog', 'Sentry', 'Vercel', 'Jira', 'Figma'];
    expect(buildAsrPrompt(terms, { style: 'sentence' })).toBe(buildAsrPrompt(terms, { style: 'sentence' }));
  });

  it('respects the word limit and merges duplicates (differing in case or width) into one', () => {
    expect(buildAsrPrompt(['GitHub', 'github', 'ＧｉｔＨｕｂ', 'Slack', 'Notion'], { style: 'list', maxTerms: 2, importantLast: false })).toBe('GitHub、Slack。');
  });

  it('drops the least important words or sentences first when over the length limit', () => {
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

  it('puts the preceding context last', () => {
    expect(buildAsrPrompt(['GitHub'], { style: 'list', context: '昨日の続きです。' })).toBe('GitHub。昨日の続きです。');
    expect(buildAsrPrompt([], { style: 'sentence', context: '昨日の続きです。' })).toBe('昨日の続きです。');
  });

  it('returns empty without words or context', () => {
    expect(buildAsrPrompt([], { style: 'sentence' })).toBe('');
    expect(buildAsrPrompt(['  '], { style: 'list' })).toBe('');
  });
});
