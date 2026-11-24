/**
 * Splits the audio at pauses (silence) while recording. The segments are transcribed during the recording, so that after the key
 * is released only the last segment has to be waited for.
 *
 * Decisions use the RMS of 100ms frames. The noise level is estimated from the lower RMS values during the recording.
 */
export interface SegmenterOptions {
  sampleRate: number;
  /** No segment shorter than this is made */
  minSegmentSec: number;
  /** Past this length, split even at a short silence (whisper's window is 30 seconds) */
  maxSegmentSec: number;
  /** Length of silence that counts as a break */
  minSilenceSec: number;
  /** Length of silence that calls onPause (default 0.3 seconds; for changing it in evaluation) */
  pauseSec?: number;
  /** Threshold of speechAfter (max(strictFloor, noise × strictFactor)). Defaults are STRICT_SPEECH_FLOOR and STRICT_SPEECH_FACTOR */
  strictFloor?: number;
  strictFactor?: number;
}

/**
 * whisper processes a 30-second window at once, so transcribing 5 seconds of audio takes about as long as 25 seconds
 * (about 0.5 seconds on M1/M2). Short segments cut the context and lower accuracy (CER 11.7% → 13.1% with 5–15 second segments).
 * So segments are cut only after 20 seconds, and always at 28 seconds to fit the 30-second window. Speech under 20 seconds is
 * transcribed whole after the key is released.
 */
export const DEFAULT_SEGMENTER: SegmenterOptions = {
  sampleRate: 16000,
  minSegmentSec: 20,
  maxSegmentSec: 28,
  minSilenceSec: 0.5,
};

/** Recordings up to this length are transcribed whole instead of using the segments made while recording (whisper's window is 30 seconds). The app and the evaluation use the same value */
export const WHOLE_MAX_SEC = 28;

const FRAME = 1600; // 100ms
/** Silence included in a segment (frames) */
const PAD_FRAMES = 3;
/** After this much audio without speech, the start is moved forward */
const SKIP_SILENCE_FRAMES = 15;
/** Length of silence that counts as a pause in speech (frames). Triggers speculative transcription */
export const PAUSE_FRAMES = 3;
/**
 * Speech threshold (max(floor, noise × factor)) for deciding whether a speculative transcription result can be used.
 * It is much lower than the threshold for splitting (max(0.004, noise × 2.5)). When the ends of sentences fade out,
 * whisper picks up endings at RMS 0.002–0.0035, so with the splitting threshold the speculative result would miss the endings
 * (on 50 evaluation recordings, floor 0.004 and factor 2.0 gave CER 10.3% → 11.8%; floor 0.001 and factor 1.5 kept 10.3%)
 */
export const STRICT_SPEECH_FACTOR = 1.5;
export const STRICT_SPEECH_FLOOR = 0.001;

export class Segmenter {
  private samples: Float32Array[] = [];
  private total = 0;
  /** Start of the next segment (samples) */
  private cut = 0;
  private frameRms: number[] = [];
  private noise = 0.003;
  private pendingFrame: number[] = [];
  /** Whether the current segment has had a frame that looks like speech */
  private segHasSpeech = false;
  /** Number of silent frames at the end */
  private silentRun = 0;
  private lastSpeech = 0;
  private lastLoud = 0;
  /**
   * Called when PAUSE_FRAMES of silence follow speech (end is the length of the recording so far).
   * Used for speculative transcription. Unlike the segments made while recording (onSegment), it is called on short pauses too
   */
  onPause?: (end: number) => void;

  private readonly pauseFrames: number;
  private readonly strictFloor: number;
  private readonly strictFactor: number;

  constructor(
    private readonly onSegment: (start: number, end: number) => void,
    private readonly opts: SegmenterOptions = DEFAULT_SEGMENTER,
  ) {
    this.pauseFrames = opts.pauseSec !== undefined ? Math.max(1, Math.round((opts.pauseSec * opts.sampleRate) / FRAME)) : PAUSE_FRAMES;
    this.strictFloor = opts.strictFloor ?? STRICT_SPEECH_FLOOR;
    this.strictFactor = opts.strictFactor ?? STRICT_SPEECH_FACTOR;
  }

  push(chunk: Float32Array): void {
    this.samples.push(chunk);
    this.total += chunk.length;
    for (let i = 0; i < chunk.length; i++) {
      this.pendingFrame.push(chunk[i]);
      if (this.pendingFrame.length === FRAME) {
        let sum = 0;
        for (const v of this.pendingFrame) sum += v * v;
        const rms = Math.sqrt(sum / FRAME);
        this.frameRms.push(rms);
        this.pendingFrame = [];
        // Noise estimate: rises slowly, falls quickly
        this.noise = rms < this.noise ? this.noise * 0.7 + rms * 0.3 : this.noise * 0.995 + rms * 0.005;
        const end = this.frameRms.length * FRAME;
        if (rms >= Math.max(this.strictFloor, this.noise * this.strictFactor)) this.lastLoud = end;
        if (!this.isSilent(rms)) {
          this.segHasSpeech = true;
          this.silentRun = 0;
          this.lastSpeech = end;
        } else if (++this.silentRun === this.pauseFrames && this.lastSpeech > 0) {
          this.onPause?.(end);
        }
        this.check();
      }
    }
  }

  private isSilent(rms: number): boolean {
    return rms < Math.max(0.004, this.noise * 2.5);
  }

  private check(): void {
    const sr = this.opts.sampleRate;
    const frames = this.frameRms.length;
    const segStartFrame = Math.floor(this.cut / FRAME);

    // Do not send a stretch without speech to transcription; move the start forward instead (keeping the last 0.3 seconds)
    if (!this.segHasSpeech) {
      if (frames - segStartFrame >= SKIP_SILENCE_FRAMES) this.cut = (frames - PAD_FRAMES) * FRAME;
      return;
    }

    const segLenSec = ((frames - segStartFrame) * FRAME) / sr;
    if (segLenSec < this.opts.minSegmentSec) return;
    const needSilence = Math.round((this.opts.minSilenceSec * sr) / FRAME);
    let run = 0;
    for (let f = frames - 1; f >= segStartFrame && this.isSilent(this.frameRms[f]); f--) run++;
    if (run >= needSilence) {
      // Cut a little after the end of speech, including some silence. The rest of the silence is skipped at the start of the next segment
      const speechEnd = frames - run;
      this.emitCut((speechEnd + Math.min(PAD_FRAMES, Math.ceil(run / 2))) * FRAME);
      return;
    }
    if (segLenSec >= this.opts.maxSegmentSec) {
      // Cut at the quietest point in the last 3 seconds
      const from = Math.max(segStartFrame + 1, frames - Math.round((3 * sr) / FRAME));
      let best = frames - 1;
      for (let f = from; f < frames; f++) if (this.frameRms[f] < this.frameRms[best]) best = f;
      this.emitCut(best * FRAME);
    }
  }

  private emitCut(at: number): void {
    if (at <= this.cut) return;
    const start = this.cut;
    this.cut = at;
    // If the frames from the cut until now contain speech, the next segment starts with speech too
    const fromFrame = Math.floor(at / FRAME);
    this.segHasSpeech = this.frameRms.slice(fromFrame).some((r) => !this.isSilent(r));
    this.onSegment(start, at);
  }

  /** Returns the audio from start to end */
  slice(start: number, end: number = this.total): Float32Array {
    const out = new Float32Array(Math.max(0, end - start));
    let pos = 0;
    let written = 0;
    for (const c of this.samples) {
      const cStart = pos;
      const cEnd = pos + c.length;
      pos = cEnd;
      if (cEnd <= start) continue;
      if (cStart >= end) break;
      const s = Math.max(start, cStart) - cStart;
      const e = Math.min(end, cEnd) - cStart;
      out.set(c.subarray(s, e), written);
      written += e - s;
    }
    return out;
  }

  all(): Float32Array {
    return this.slice(0, this.total);
  }

  get lastCut(): number {
    return this.cut;
  }

  /** Whether there is something like speech after the last cut (if not, the tail need not be transcribed) */
  get hasPendingSpeech(): boolean {
    return this.segHasSpeech;
  }

  get length(): number {
    return this.total;
  }

  /** End of the last frame that looks like speech (samples). 0 if there is no speech */
  get lastSpeechEnd(): number {
    return this.lastSpeech;
  }

  /**
   * Whether there is a frame after at (samples) that may be speech. Uses a lower threshold (STRICT_SPEECH_FACTOR) than splitting.
   * Used to tell whether anything was said after a speculative transcription
   */
  speechAfter(at: number): boolean {
    return this.lastLoud > at;
  }

  /** End of the last frame that may be speech (samples). Same threshold as speechAfter */
  get lastLoudEnd(): number {
    return this.lastLoud;
  }

  /** Peak amplitude of the whole recording and the share of frames that look like speech (for detecting silence) */
  stats(): { peak: number; speechRatio: number; meanRms: number } {
    let peak = 0;
    for (const c of this.samples) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
    const speech = this.frameRms.filter((r) => r > Math.max(0.01, this.noise * 3)).length;
    const meanRms = this.frameRms.length ? this.frameRms.reduce((a, b) => a + b, 0) / this.frameRms.length : 0;
    return { peak, speechRatio: this.frameRms.length ? speech / this.frameRms.length : 0, meanRms };
  }
}

/** Engines whose worker has voice activity detection (VAD) and returns nothing for a recording without voice */
const ENGINES_WITH_VAD = new Set(['whisper']);

/**
 * Whether to drop a recording as having no voice before transcribing it (REC-5).
 *
 * Loudness alone cannot tell a quiet voice from the noise of a quiet room.
 * On 135 recordings of public read-speech data, 25 quiet ones (mean RMS under 0.003) were dropped as silence.
 * Transcribed without this check, those 25 had an error rate of 2.9%, so they are recognized normally.
 * On 60 noise-only recordings (white noise, hum, typing-like sounds; RMS 0.0005–0.01), the whisper worker produced no text.
 * So for engines whose worker has voice detection, nothing is dropped here and the worker decides (without voice it returns
 * nothing, which leads to the same notification).
 * Other engines still drop by loudness as before.
 */
export function isNoSpeechByLevel(stats: { speechRatio: number; meanRms: number }, opts: { silenceDetection: boolean; engine: string }): boolean {
  if (!opts.silenceDetection || ENGINES_WITH_VAD.has(opts.engine)) return false;
  return stats.speechRatio === 0 && stats.meanRms < 0.003;
}
