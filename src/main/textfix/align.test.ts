/**
 * Tests for confidence alignment. All sentences are made-up examples.
 */
import { describe, expect, it } from 'vitest';
import { charConfidence, minContentConfidence, rangeConfidence, realign } from './align';

describe('confidence alignment', () => {
  it('assigns each character its value when the joined text equals the transcript', () => {
    expect(
      charConfidence('今日は', [
        ['今日', 0.9],
        ['は', 0.5],
      ]),
    ).toEqual([0.9, 0.9, 0.5]);
  });

  it('assigns only matching characters when a leading space or removed repetition shifts the text', () => {
    // The worker sometimes adds a leading space, while the transcript has leading and trailing whitespace trimmed
    expect(
      charConfidence('明日行く', [
        [' 明日', 0.8],
        ['行く', 0.6],
      ]),
    ).toEqual([0.8, 0.8, 0.6, 0.6]);
    // Characters only on the worker side (removed as repetitions) are skipped; characters only in the transcript get null
    expect(
      charConfidence('はいそう', [
        ['はいはい', 0.9],
        ['そう', 0.4],
      ]),
    ).toEqual([0.9, 0.9, 0.4, 0.4]);
    expect(
      charConfidence('はい、そう', [
        ['はい', 0.9],
        ['そう', 0.4],
      ]),
    ).toEqual([0.9, 0.9, null, 0.4, 0.4]);
  });

  it('returns null when there are no pairs or they are malformed', () => {
    expect(charConfidence('今日', undefined)).toBeNull();
    expect(charConfidence('今日', [])).toBeNull();
    expect(charConfidence('今日', [['今日', Number.NaN]])).toBeNull();
  });

  it('leaves replaced spans without confidence when moving onto the replaced text', () => {
    const conf = [0.9, 0.9, 0.9, 0.9, 0.3, 0.9];
    expect(realign('すらっくで', conf, 'Slackで')).toEqual([null, null, null, null, null, 0.3]);
    expect(realign('ABC', [0.1, 0.2, 0.3], 'ABC')).toEqual([0.1, 0.2, 0.3]);
  });

  it('gives the minimum over a range and over content characters, and null for a range with a character without confidence', () => {
    const conf = [0.9, 0.4, null, 0.8];
    expect(rangeConfidence(conf, 0, 2)).toBe(0.4);
    expect(rangeConfidence(conf, 1, 3)).toBeNull();
    expect(rangeConfidence(null, 0, 1)).toBeNull();
    // Punctuation confidence does not count
    expect(minContentConfidence('はい。', [0.9, 0.8, 0.1])).toBe(0.8);
    expect(minContentConfidence('はい', [null, null])).toBeNull();
  });
});
