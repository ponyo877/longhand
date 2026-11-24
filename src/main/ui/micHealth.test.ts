import { describe, expect, it } from 'vitest';
import { dbfs, MicHealth, percentile } from './micHealth';

const fromDb = (db: number) => 10 ** (db / 20);

function session(h: MicHealth, device: string, speechDb: number, ms = 5000): ReturnType<MicHealth['end']> {
  h.begin();
  // Speech (loud) and the silence between phrases
  for (let i = 0; i < 30; i++) h.push(fromDb(speechDb));
  for (let i = 0; i < 20; i++) h.push(fromDb(-75));
  return h.end(device, ms);
}

describe('micHealth', () => {
  it('computes dBFS and percentiles', () => {
    expect(dbfs(1)).toBe(0);
    expect(Math.round(dbfs(0.01))).toBe(-40);
    expect(dbfs(0)).toBe(-120);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
  });

  it('judges a microphone quiet when 3 of the last 5 sessions are at or below -50 dBFS', () => {
    const h = new MicHealth(null);
    expect(session(h, 'mic', -55)?.quiet).toBe(false);
    expect(session(h, 'mic', -30)?.quiet).toBe(false);
    expect(session(h, 'mic', -56)?.quiet).toBe(false);
    expect(session(h, 'mic', -58)?.quiet).toBe(true);
    // Other microphones are counted separately
    expect(session(h, 'other', -58)?.quiet).toBe(false);
    // After a run of normal levels, the old records are pushed out and it is no longer judged quiet
    session(h, 'mic', -25);
    session(h, 'mic', -25);
    expect(session(h, 'mic', -25)?.quiet).toBe(false);
    expect(h.history('mic')).toHaveLength(5);
  });

  it('records nothing for short recordings, a missing microphone name or complete silence', () => {
    const h = new MicHealth(null);
    expect(session(h, 'mic', -60, 2000)).toBeNull();
    expect(session(h, '', -60)).toBeNull();
    h.begin();
    for (let i = 0; i < 50; i++) h.push(0);
    expect(h.end('mic', 5000)).toBeNull();
    expect(h.history('mic')).toEqual([]);
  });
});
