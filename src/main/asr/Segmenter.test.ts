import { describe, expect, it } from 'vitest';
import { DEFAULT_SEGMENTER, isNoSpeechByLevel, Segmenter } from './Segmenter';

const SR = 16000;

/** 発話の代わりに、振幅の揺れる正弦波を使う */
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
  // 区切りの判定を短い音声で確かめるため、最短 6 秒、最長 24 秒で動かす
  const seg = new Segmenter((s, e) => cuts.push([s / SR, e / SR]), { ...DEFAULT_SEGMENTER, minSegmentSec: 6, maxSegmentSec: 24 });
  for (const p of parts) for (let i = 0; i < p.length; i += 1600) seg.push(p.subarray(i, Math.min(p.length, i + 1600)));
  return { cuts, seg };
}

describe('Segmenter', () => {
  it('既定では 20 秒未満の発話を区切らない（whisper は丸ごと書き起こす方が正確）', () => {
    const cuts: number[] = [];
    const seg = new Segmenter((_s, e) => cuts.push(e));
    for (const p of [speech(8), silence(1), speech(8), silence(1)]) for (let i = 0; i < p.length; i += 1600) seg.push(p.subarray(i, i + 1600));
    expect(cuts).toHaveLength(0);
  });

  it('区切りは発話の終わりのすぐ後に置く', () => {
    const { cuts } = run([speech(8), silence(1), speech(4)]);
    expect(cuts).toHaveLength(1);
    expect(cuts[0][0]).toBe(0);
    expect(cuts[0][1]).toBeGreaterThanOrEqual(8);
    expect(cuts[0][1]).toBeLessThanOrEqual(8.4);
  });

  it('6 秒未満では区切らない', () => {
    const { cuts } = run([speech(3), silence(1), speech(1.5)]);
    expect(cuts).toHaveLength(0);
  });

  it('長い無音だけの区切りを作らない', () => {
    const { cuts, seg } = run([speech(7), silence(10), speech(3)]);
    expect(cuts).toHaveLength(1);
    expect(cuts[0][1]).toBeLessThanOrEqual(7.4);
    // 無音は飛ばされ、末尾は 2 発話目の少し前から始まる
    expect(seg.lastCut / SR).toBeGreaterThan(15);
    expect(seg.hasPendingSpeech).toBe(true);
  });

  it('末尾が無音だけなら、書き起こし不要と分かる', () => {
    const { cuts, seg } = run([speech(7), silence(4)]);
    expect(cuts).toHaveLength(1);
    expect(seg.hasPendingSpeech).toBe(false);
  });

  it('先頭の長い無音は区切りに含めない（残るのは 1.5 秒未満）', () => {
    const { cuts } = run([silence(3), speech(7), silence(1), speech(2)]);
    expect(cuts).toHaveLength(1);
    expect(cuts[0][0]).toBeGreaterThanOrEqual(1.5);
    expect(cuts[0][0]).toBeLessThanOrEqual(3);
  });

  it('話し続けても 24 秒で区切る', () => {
    const { cuts } = run([speech(30)]);
    expect(cuts.length).toBeGreaterThanOrEqual(1);
    expect(cuts[0][1] - cuts[0][0]).toBeLessThanOrEqual(24.01);
  });

  it('区切りと末尾をつなぐと、発話をすべて含む', () => {
    const parts = [speech(6.5), silence(0.8), speech(6.2), silence(0.7), speech(2)];
    const { cuts, seg } = run(parts);
    expect(cuts.length).toBe(2);
    // 区切りどうしに隙間がない
    expect(cuts[1][0]).toBe(cuts[0][1]);
    expect(seg.lastCut / SR).toBe(cuts[1][1]);
  });

  it('発話の後に 0.3 秒の無音が続くたびに onPause を呼び、その後の発話を speechAfter で知らせる', () => {
    const pauses: number[] = [];
    const seg = new Segmenter(() => undefined);
    seg.onPause = (end) => pauses.push(end / SR);
    const feed = (p: Float32Array) => {
      for (let i = 0; i < p.length; i += 1600) seg.push(p.subarray(i, Math.min(p.length, i + 1600)));
    };
    // 先頭の無音では呼ばない
    feed(silence(1));
    expect(pauses).toEqual([]);
    feed(speech(2));
    feed(silence(1));
    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toBeCloseTo(3.3, 1);
    expect(seg.lastSpeechEnd / SR).toBeCloseTo(3, 1);
    const snap = seg.length;
    expect(seg.speechAfter(snap)).toBe(false);
    // 無音が続いても speechAfter は false のまま
    feed(silence(0.5));
    expect(seg.speechAfter(snap)).toBe(false);
    // 小さな声でも話せば true
    feed(speech(0.3, 0.02));
    expect(seg.speechAfter(snap)).toBe(true);
    feed(silence(0.5));
    expect(pauses).toHaveLength(2);
  });
});

describe('isNoSpeechByLevel', () => {
  const quiet = { speechRatio: 0, meanRms: 0.001 };

  it('whisper では、音が小さくても捨てない（声の有無はワーカーが決める）', () => {
    expect(isNoSpeechByLevel(quiet, { silenceDetection: true, engine: 'whisper' })).toBe(false);
  });

  it('ワーカーが声の検出を持たないエンジンでは、音の大きさで捨てる', () => {
    expect(isNoSpeechByLevel(quiet, { silenceDetection: true, engine: 'apple' })).toBe(true);
    expect(isNoSpeechByLevel({ speechRatio: 0.2, meanRms: 0.001 }, { silenceDetection: true, engine: 'apple' })).toBe(false);
    expect(isNoSpeechByLevel({ speechRatio: 0, meanRms: 0.01 }, { silenceDetection: true, engine: 'apple' })).toBe(false);
  });

  it('設定でオフなら捨てない', () => {
    expect(isNoSpeechByLevel(quiet, { silenceDetection: false, engine: 'apple' })).toBe(false);
  });
});
