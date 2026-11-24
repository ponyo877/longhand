/**
 * 録音中に、話の切れ目（無音）で音声を区切る。区切った部分は録音中に書き起こしておき、
 * キーを離してからの待ち時間を、最後の区切りの分だけにする。
 *
 * 判定は 100ms 単位の RMS で行う。雑音の大きさは、録音中の小さい方の RMS から推定する。
 */
export interface SegmenterOptions {
  sampleRate: number;
  /** これより短い区切りは作らない */
  minSegmentSec: number;
  /** この長さを超えたら、無音が短くても区切る（whisper の窓は 30 秒） */
  maxSegmentSec: number;
  /** 区切りとみなす無音の長さ */
  minSilenceSec: number;
  /** onPause を呼ぶ無音の長さ（既定 0.3 秒。評価で変えるためのもの） */
  pauseSec?: number;
  /** speechAfter の閾値（max(strictFloor, 雑音 × strictFactor)）。既定は STRICT_SPEECH_FLOOR と STRICT_SPEECH_FACTOR */
  strictFloor?: number;
  strictFactor?: number;
}

/**
 * whisper は 30 秒の窓をまとめて処理するので、5 秒の音声でも 25 秒の音声でも書き起こしの時間はほとんど変わらない
 * （M1/M2 で約 0.5 秒）。短く区切ると文脈が切れて精度が落ちる（5〜15 秒の区切りで CER 11.7% → 13.1%）。
 * そこで 20 秒を超えてから区切り、30 秒の窓に収まる 28 秒で必ず区切る。20 秒未満の発話は離した後に丸ごと書き起こす。
 */
export const DEFAULT_SEGMENTER: SegmenterOptions = {
  sampleRate: 16000,
  minSegmentSec: 20,
  maxSegmentSec: 28,
  minSilenceSec: 0.5,
};

/** これ以下の長さの録音は、録音中の区切りを使わずに丸ごと書き起こす（whisper の窓は 30 秒）。アプリと評価で同じ値を使う */
export const WHOLE_MAX_SEC = 28;

const FRAME = 1600; // 100ms
/** 区切りに含める無音（フレーム数） */
const PAD_FRAMES = 3;
/** 発話のない部分がこれだけ続いたら、先頭を進める */
const SKIP_SILENCE_FRAMES = 15;
/** 話の間とみなす無音の長さ（フレーム数）。投機的な書き起こしのきっかけにする */
export const PAUSE_FRAMES = 3;
/**
 * 投機的な書き起こしの結果を使ってよいかの判定に使う、発話らしさの閾値（max(下限, 雑音 × 倍率)）。
 * 区切りの判定（max(0.004, 雑音 × 2.5)）よりずっと低くする。語尾が小さく消えていく話し方では、
 * RMS 0.002〜0.0035 の語尾を whisper は拾うので、区切りと同じ閾値では投機の結果から語尾が欠ける
 * （評価の 50 本で、下限 0.004・倍率 2.0 だと CER 10.3% → 11.8%、下限 0.001・倍率 1.5 だと 10.3% のまま）
 */
export const STRICT_SPEECH_FACTOR = 1.5;
export const STRICT_SPEECH_FLOOR = 0.001;

export class Segmenter {
  private samples: Float32Array[] = [];
  private total = 0;
  /** 次の区切りの開始位置（サンプル） */
  private cut = 0;
  private frameRms: number[] = [];
  private noise = 0.003;
  private pendingFrame: number[] = [];
  /** 今の区切りに発話らしいフレームがあったか */
  private segHasSpeech = false;
  /** 末尾から続いている無音のフレーム数 */
  private silentRun = 0;
  private lastSpeech = 0;
  private lastLoud = 0;
  /**
   * 発話の後に無音が PAUSE_FRAMES 続いた時点で呼ぶ（end は今までの録音の長さ）。
   * 投機的な書き起こしに使う。録音中の区切り（onSegment）とは別に、短い間でも呼ぶ
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
        // 雑音の推定: ゆっくり上がり、速く下がる
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

    // 発話のないまま続いている部分は書き起こしに回さず、先頭を進める（直前の 0.3 秒は残す）
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
      // 発話の終わりから少しだけ無音を含めて区切る。残りの無音は次の区切りの先頭で飛ばされる
      const speechEnd = frames - run;
      this.emitCut((speechEnd + Math.min(PAD_FRAMES, Math.ceil(run / 2))) * FRAME);
      return;
    }
    if (segLenSec >= this.opts.maxSegmentSec) {
      // 直近 3 秒で一番静かなところで区切る
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
    // 区切った位置から今までのフレームに発話があれば、次の区切りも発話ありから始める
    const fromFrame = Math.floor(at / FRAME);
    this.segHasSpeech = this.frameRms.slice(fromFrame).some((r) => !this.isSilent(r));
    this.onSegment(start, at);
  }

  /** start から end までの音声を取り出す */
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

  /** 最後の区切りより後に、発話らしい部分があるか（なければ末尾は書き起こさなくてよい） */
  get hasPendingSpeech(): boolean {
    return this.segHasSpeech;
  }

  get length(): number {
    return this.total;
  }

  /** 最後の発話らしいフレームの終わり（サンプル）。発話がなければ 0 */
  get lastSpeechEnd(): number {
    return this.lastSpeech;
  }

  /**
   * at（サンプル）より後に、発話かもしれないフレームがあるか。区切りの判定より低い閾値（STRICT_SPEECH_FACTOR）で見る。
   * 投機的な書き起こしの後に何か話したかの判定に使う
   */
  speechAfter(at: number): boolean {
    return this.lastLoud > at;
  }

  /** 発話かもしれない最後のフレームの終わり（サンプル）。speechAfter と同じ閾値 */
  get lastLoudEnd(): number {
    return this.lastLoud;
  }

  /** 全体の最大振幅と、発話らしいフレームの割合（無音の判定用） */
  stats(): { peak: number; speechRatio: number; meanRms: number } {
    let peak = 0;
    for (const c of this.samples) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
    const speech = this.frameRms.filter((r) => r > Math.max(0.01, this.noise * 3)).length;
    const meanRms = this.frameRms.length ? this.frameRms.reduce((a, b) => a + b, 0) / this.frameRms.length : 0;
    return { peak, speechRatio: this.frameRms.length ? speech / this.frameRms.length : 0, meanRms };
  }
}

/** ワーカーが声の検出（VAD）を持ち、声の無い録音に空を返すエンジン */
const ENGINES_WITH_VAD = new Set(['whisper']);

/**
 * 声の入っていない録音として、書き起こす前に捨てるか（REC-5）。
 *
 * 音の大きさだけでは、声の小さい録音と、静かな部屋の雑音を見分けられない。
 * 公開の読み上げデータ 135 件で確かめると、声の小さい 25 件（平均の RMS が 0.003 未満）を無音として捨てていた。
 * 判定を外して書き起こすと、その 25 件の誤り率は 2.9% で、ふつうに認識できる。
 * 一方、雑音だけの録音 60 件（白色雑音、ハム、打鍵のような音。RMS 0.0005〜0.01）で、whisper のワーカーは文を出さなかった。
 * そこで、ワーカーが声の検出を持つエンジンでは、ここでは捨てずにワーカーに任せる（声が無ければ空が返り、同じ通知になる）。
 * ほかのエンジンでは、従来どおり音の大きさで捨てる。
 */
export function isNoSpeechByLevel(stats: { speechRatio: number; meanRms: number }, opts: { silenceDetection: boolean; engine: string }): boolean {
  if (!opts.silenceDetection || ENGINES_WITH_VAD.has(opts.engine)) return false;
  return stats.speechRatio === 0 && stats.meanRms < 0.003;
}
