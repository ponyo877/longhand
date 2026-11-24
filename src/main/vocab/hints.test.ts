import { describe, expect, it } from 'vitest';
import { countTerm, rankVocabulary, type VocabEntry } from './hints';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 15);

function entries(words: string[]): VocabEntry[] {
  return words.map((word, i) => ({ word, recency: words.length > 1 ? i / (words.length - 1) : 1 }));
}

describe('countTerm', () => {
  it('英字の語は単語の途中では数えない', () => {
    expect(countTerm('postgres と postgresql', 'Postgres')).toBe(1);
    expect(countTerm('grafana,grafana', 'Grafana')).toBe(2);
  });

  it('日本語の語はそのまま数える', () => {
    expect(countTerm('日鷹さんと日鷹さん', '日鷹')).toBe(2);
  });
});

describe('rankVocabulary（G4-09）', () => {
  it('文脈がなければ新しく登録した語を先にする', () => {
    const r = rankVocabulary(entries(['Alpha', 'Bravo', 'Charlie']), { now: NOW });
    expect(r.map((x) => x.word)).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('入力欄にある語を上げる', () => {
    const r = rankVocabulary(entries(['Grafana', 'Datadog', 'Postgres']), {
      now: NOW,
      context: { beforeCursor: 'Grafana のダッシュボードについて' },
    });
    expect(r[0].word).toBe('Grafana');
  });

  it('ウィンドウのタイトルやホストにある語を上げる', () => {
    const r = rankVocabulary(entries(['Grafana', 'Datadog', 'Postgres']), {
      now: NOW,
      context: { windowTitle: 'Datadog - Monitors' },
    });
    expect(r[0].word).toBe('Datadog');
  });

  it('最近同じアプリで使った語を上げる', () => {
    const r = rankVocabulary(entries(['Grafana', 'Datadog', 'Postgres']), {
      now: NOW,
      context: { bundleId: 'com.example.chat' },
      recent: [{ text: 'Grafana を見てください', timestamp: NOW - DAY, app: { bundleId: 'com.example.chat' } }],
    });
    expect(r[0].word).toBe('Grafana');
  });

  it('最近学習した語を上げる', () => {
    const e = entries(['Grafana', 'Datadog', 'Postgres']);
    e[0].learnedAt = NOW - 2 * DAY;
    const r = rankVocabulary(e, { now: NOW });
    expect(r[0].word).toBe('Grafana');
  });

  it('生テキストで聞き取られた読みも、使われたとみなす', () => {
    const e = entries(['Grafana', 'Datadog', 'Postgres']);
    e[0].readings = ['グラファナ'];
    const r = rankVocabulary(e, { now: NOW, recent: [{ text: 'ぐらふぁなを見て', rawText: 'ぐらふぁなを見て', timestamp: NOW - DAY }] });
    expect(r[0].word).toBe('Grafana');
  });

  it('14 日より前の書き起こしは数えない', () => {
    const r = rankVocabulary(entries(['Grafana', 'Datadog', 'Postgres']), {
      now: NOW,
      recent: [{ text: 'Grafana', timestamp: NOW - 20 * DAY }],
    });
    expect(r[0].word).toBe('Postgres');
  });
});
