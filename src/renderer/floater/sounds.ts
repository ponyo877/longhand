import type { SoundName } from '../../shared/types';

/**
 * 効果音（REC-4）。音源ファイルを持たず、WebAudio で毎回合成する。
 */
let ctx: AudioContext | null = null;

function tone(c: AudioContext, freq: number, start: number, dur: number, gain: number, type: OscillatorType = 'sine', toFreq?: number): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (toFreq) osc.frequency.exponentialRampToValueAtTime(toFreq, start + dur);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g).connect(c.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

export function playSound(name: SoundName, volume: number): void {
  if (volume <= 0) return;
  ctx ??= new AudioContext();
  const c = ctx;
  if (c.state === 'suspended') void c.resume();
  const t = c.currentTime + 0.005;
  const v = Math.min(1, volume) * 0.18;
  // 開始と停止は 100ms 以内に収める（A1）。開始音はマイクが開いてから鳴るので、長いと録音に入って認識の邪魔になる
  switch (name) {
    case 'start':
      tone(c, 740, t, 0.045, v);
      tone(c, 1110, t + 0.035, 0.06, v);
      break;
    case 'lock':
      tone(c, 740, t, 0.04, v);
      tone(c, 988, t + 0.03, 0.035, v);
      tone(c, 1245, t + 0.055, 0.045, v);
      break;
    case 'stop':
      tone(c, 1110, t, 0.04, v);
      tone(c, 740, t + 0.03, 0.06, v);
      break;
    case 'cancel':
      tone(c, 440, t, 0.16, v * 0.8, 'triangle', 300);
      break;
    case 'error':
      tone(c, 330, t, 0.12, v, 'triangle');
      tone(c, 247, t + 0.12, 0.18, v, 'triangle');
      break;
    case 'notify':
      tone(c, 1046, t, 0.12, v * 0.7);
      break;
  }
}
