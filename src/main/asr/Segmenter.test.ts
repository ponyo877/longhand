import { describe, expect, it } from 'vitest';
import { DEFAULT_SEGMENTER, isNoSpeechByLevel, Segmenter } from './Segmenter';

const SR = 16000;

/** A sine wave with varying amplitude stands in for speech */
function speech(sec: number, amp = 0.1): Float32Array {
  const out = new Float32Array(Math.round(sec * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / SR));
  return out;
}

function silence(sec: number, noise = 0.0005): Float32Array {
  const out = new Float32Array(Math.round(sec * SR));
  let x = 1;
  for (let i = 0; i < out.length; i++) {
    x = (x * 16807) % 2147483647;
    out[i] = noise * ((x / 2147483647) * 2 - 1);
  }
  return out;
}

function run(parts: Float32Array[]): { cuts: [number, number][]; seg: Segmenter } {
  const cuts: [number, number][] = [];
  // Run with a 6-second minimum and a 24-second maximum to test splitting with short audio
  const seg = new Segmenter((s, e) => cuts.push([s / SR, e / SR]), { ...DEFAULT_SEGMENTER, minSegmentSec: 6, maxSegmentSec: 24 });
  for (const p of parts) for (let i = 0; i < p.length; i += 1600) seg.push(p.subarray(i, Math.min(p.length, i + 1600)));
  return { cuts, seg };
}

describe('Segmenter', () => {
  it('does not split speech under 20 seconds by default (whisper is more accurate transcribing it whole)', () => {
    const cuts: number[] = [];
    const seg = new Segmenter((_s, e) => cuts.push(e));
    for (const p of [speech(8), silence(1), speech(8), silence(1)]) for (let i = 0; i < p.length; i += 1600) seg.push(p.subarray(i, i + 1600));
    expect(cuts).toHaveLength(0);
  });

  it('cuts right after the end of speech', () => {
    const { cuts } = run([speech(8), silence(1), speech(4)]);
    expect(cuts).toHaveLength(1);
    expect(cuts[0][0]).toBe(0);
    expect(cuts[0][1]).toBeGreaterThanOrEqual(8);
    expect(cuts[0][1]).toBeLessThanOrEqual(8.4);
  });

  it('does not cut before 6 seconds', () => {
    const { cuts } = run([speech(3), silence(1), speech(1.5)]);
    expect(cuts).toHaveLength(0);
  });

  it('does not make a segment of long silence alone', () => {
    const { cuts, seg } = run([speech(7), silence(10), speech(3)]);
    expect(cuts).toHaveLength(1);
    expect(cuts[0][1]).toBeLessThanOrEqual(7.4);
    // The silence is skipped, and the tail starts a little before the second utterance
    expect(seg.lastCut / SR).toBeGreaterThan(15);
    expect(seg.hasPendingSpeech).toBe(true);
  });

  it('knows the tail needs no transcription when it is only silence', () => {
    const { cuts, seg } = run([speech(7), silence(4)]);
    expect(cuts).toHaveLength(1);
    expect(seg.hasPendingSpeech).toBe(false);
  });

  it('leaves a long leading silence out of the segment (less than 1.5 seconds remains)', () => {
    const { cuts } = run([silence(3), speech(7), silence(1), speech(2)]);
    expect(cuts).toHaveLength(1);
    expect(cuts[0][0]).toBeGreaterThanOrEqual(1.5);
    expect(cuts[0][0]).toBeLessThanOrEqual(3);
  });

  it('cuts at 24 seconds even during continuous speech', () => {
    const { cuts } = run([speech(30)]);
    expect(cuts.length).toBeGreaterThanOrEqual(1);
    expect(cuts[0][1] - cuts[0][0]).toBeLessThanOrEqual(24.01);
  });

  it('covers all the speech when the segments and the tail are joined', () => {
    const parts = [speech(6.5), silence(0.8), speech(6.2), silence(0.7), speech(2)];
    const { cuts, seg } = run(parts);
    expect(cuts.length).toBe(2);
    // No gaps between segments
    expect(cuts[1][0]).toBe(cuts[0][1]);
    expect(seg.lastCut / SR).toBe(cuts[1][1]);
  });

  it('calls onPause each time 0.3 seconds of silence follows speech, and reports later speech through speechAfter', () => {
    const pauses: number[] = [];
    const seg = new Segmenter(() => undefined);
    seg.onPause = (end) => pauses.push(end / SR);
    const feed = (p: Float32Array) => {
      for (let i = 0; i < p.length; i += 1600) seg.push(p.subarray(i, Math.min(p.length, i + 1600)));
    };
    // Not called on the leading silence
    feed(silence(1));
    expect(pauses).toEqual([]);
    feed(speech(2));
    feed(silence(1));
    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toBeCloseTo(3.3, 1);
    expect(seg.lastSpeechEnd / SR).toBeCloseTo(3, 1);
    const snap = seg.length;
    expect(seg.speechAfter(snap)).toBe(false);
    // speechAfter stays false while the silence continues
    feed(silence(0.5));
    expect(seg.speechAfter(snap)).toBe(false);
    // True once something is said, even quietly
    feed(speech(0.3, 0.02));
    expect(seg.speechAfter(snap)).toBe(true);
    feed(silence(0.5));
    expect(pauses).toHaveLength(2);
  });
});

describe('isNoSpeechByLevel', () => {
  const quiet = { speechRatio: 0, meanRms: 0.001 };

  it('does not drop quiet audio for whisper (the worker decides whether there is voice)', () => {
    expect(isNoSpeechByLevel(quiet, { silenceDetection: true, engine: 'whisper' })).toBe(false);
  });

  it('drops by loudness for engines whose worker has no voice detection', () => {
    expect(isNoSpeechByLevel(quiet, { silenceDetection: true, engine: 'apple' })).toBe(true);
    expect(isNoSpeechByLevel({ speechRatio: 0.2, meanRms: 0.001 }, { silenceDetection: true, engine: 'apple' })).toBe(false);
    expect(isNoSpeechByLevel({ speechRatio: 0, meanRms: 0.01 }, { silenceDetection: true, engine: 'apple' })).toBe(false);
  });

  it('does not drop when turned off in the settings', () => {
    expect(isNoSpeechByLevel(quiet, { silenceDetection: false, engine: 'apple' })).toBe(false);
  });
});
