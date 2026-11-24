import { describe, expect, it } from 'vitest';
import { countTerm, rankVocabulary, type VocabEntry } from './hints';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 15);

function entries(words: string[]): VocabEntry[] {
  return words.map((word, i) => ({ word, recency: words.length > 1 ? i / (words.length - 1) : 1 }));
}

describe('countTerm', () => {
  it('does not count a Latin term inside another word', () => {
    expect(countTerm('postgres と postgresql', 'Postgres')).toBe(1);
    expect(countTerm('grafana,grafana', 'Grafana')).toBe(2);
  });

  it('counts Japanese terms as they are', () => {
    expect(countTerm('日鷹さんと日鷹さん', '日鷹')).toBe(2);
  });
});

describe('rankVocabulary (G4-09)', () => {
  it('puts newly added words first without context', () => {
    const r = rankVocabulary(entries(['Alpha', 'Bravo', 'Charlie']), { now: NOW });
    expect(r.map((x) => x.word)).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('ranks words in the field higher', () => {
    const r = rankVocabulary(entries(['Grafana', 'Datadog', 'Postgres']), {
      now: NOW,
      context: { beforeCursor: 'Grafana のダッシュボードについて' },
    });
    expect(r[0].word).toBe('Grafana');
  });

  it('ranks words in the window title or host higher', () => {
    const r = rankVocabulary(entries(['Grafana', 'Datadog', 'Postgres']), {
      now: NOW,
      context: { windowTitle: 'Datadog - Monitors' },
    });
    expect(r[0].word).toBe('Datadog');
  });

  it('ranks words recently used in the same app higher', () => {
    const r = rankVocabulary(entries(['Grafana', 'Datadog', 'Postgres']), {
      now: NOW,
      context: { bundleId: 'com.example.chat' },
      recent: [{ text: 'Grafana を見てください', timestamp: NOW - DAY, app: { bundleId: 'com.example.chat' } }],
    });
    expect(r[0].word).toBe('Grafana');
  });

  it('ranks recently learned words higher', () => {
    const e = entries(['Grafana', 'Datadog', 'Postgres']);
    e[0].learnedAt = NOW - 2 * DAY;
    const r = rankVocabulary(e, { now: NOW });
    expect(r[0].word).toBe('Grafana');
  });

  it('counts a reading heard in the raw text as a use', () => {
    const e = entries(['Grafana', 'Datadog', 'Postgres']);
    e[0].readings = ['グラファナ'];
    const r = rankVocabulary(e, { now: NOW, recent: [{ text: 'ぐらふぁなを見て', rawText: 'ぐらふぁなを見て', timestamp: NOW - DAY }] });
    expect(r[0].word).toBe('Grafana');
  });

  it('does not count transcripts older than 14 days', () => {
    const r = rankVocabulary(entries(['Grafana', 'Datadog', 'Postgres']), {
      now: NOW,
      recent: [{ text: 'Grafana', timestamp: NOW - 20 * DAY }],
    });
    expect(r[0].word).toBe('Postgres');
  });
});
