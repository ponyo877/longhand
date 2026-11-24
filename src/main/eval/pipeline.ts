/**
 * 評価の 1 発話分の流れ。音声 → 書き起こし → 書き起こしの後の処理（postAsr）→ 段階ごとの文。
 *
 * アプリ（DictationController.runPipeline）と同じ手順にしてある。
 * - 28 秒以下の録音は丸ごと書き起こす。それより長い録音は、話の切れ目で区切って順に書き起こし、つなぐ
 * - 短すぎる録音と無音の録音は書き起こさない（アプリは何も入力しない）
 * - 書き起こしの後の処理は、アプリと同じ関数（postAsr）を通す
 *
 * アプリと違う所: 話の間での先回り（speculative）と、入力先の文脈（アプリ名、カーソルの前後）は再現しない。
 * 貼り付けの組み立て（置換、空白の補正）も通さない。
 */
import type { AsrLanguage, AsrResultPayload } from '../../shared/asr-protocol';
import type { TranscribeOptions } from '../asr/AsrService';
import type { Uncertain } from '../asr/hypotheses';
import { asrRequestExtras, uncertainOf } from '../asr/requestOptions';
import { isNoSpeechByLevel, Segmenter, WHOLE_MAX_SEC } from '../asr/Segmenter';
import { transcribeSelective, type HintMode } from '../asr/selectiveHints';
import { joinTexts } from '../format/postprocess';
import type { LlmProvider } from '../llm/types';
import { postAsr, type PostAsrCustomizations, type PostAsrResult, type PostAsrSettings } from '../session/postAsr';
import type { Tokenizer } from '../textfix';
import { charConfidence } from '../textfix/align';
import type { HintContext, RecentText } from '../vocab/hints';

const SR = 16000;

/** 書き起こしの入口（AsrService がそのまま渡せる） */
export interface Transcriber {
  transcribe(samples: Float32Array, opts: TranscribeOptions): Promise<AsrResultPayload>;
}

export interface AppAsrOptions {
  language: AsrLanguage;
  hints: string[];
  /** 丸ごと書き起こすときの prompt。アプリは渡さない（実験用） */
  prompt?: string;
  /** 設定の asr.incremental。オフなら長い録音も丸ごと書き起こす */
  incremental: boolean;
  minRecordingMs: number;
  silenceDetection: boolean;
  /** 設定の asr.engine。声の入っていない録音を、音の大きさで捨てるかどうかが変わる（既定は whisper） */
  engine?: string;
  /** 1 回の書き起こしの時間切れ。評価では待ち時間の制限がないので長めにする */
  timeoutMs?: number;
  /** 設定の asr.hintMode。selective なら、ヒントなしとヒントありの 2 回書き起こして、ヒントが効いた所だけを取り込む */
  hintMode?: HintMode;
  /** 設定の asr のうち、要求に付ける任意の指定（プロンプトの様式、聞き直し、別候補）。アプリと同じ関数で要求に直す */
  asr?: { promptStyle?: 'legacy' | 'list' | 'sentence' | 'spoken'; promptTerms?: number; rehear?: { noHints: boolean; temperatures: number[] }; alternativesTopK?: number };
}

export interface AsrOutcome {
  /** 書き起こしの生の出力（前後の空白を除く）。アプリが書き起こさない録音では空 */
  text: string;
  /** 丸ごと書き起こしたときの語ごとの確信度 */
  tokens?: [string, number][];
  /** 何回の書き起こしでできたか（丸ごとなら 1、書き起こさなければ 0） */
  segments: number;
  hintsUsed?: number;
  hintsGiven?: number;
  /** 書き起こしにかかった時間の合計 */
  computeMs: number;
  /** アプリが書き起こさずに捨てる録音（短すぎる、音が無い、話していない） */
  skipped?: 'too-short' | 'silent' | 'no-speech';
  /** 聞き違いかもしれない箇所（丸ごと書き起こし、聞き直しか別候補を求めたときだけ） */
  uncertain?: Uncertain[];
}

/** アプリと同じ手順で書き起こす */
export async function transcribeLikeApp(asr: Transcriber, samples: Float32Array, o: AppAsrOptions): Promise<AsrOutcome> {
  const cuts: [number, number][] = [];
  const seg = new Segmenter((s, e) => cuts.push([s, e]));
  for (let i = 0; i < samples.length; i += 1600) seg.push(samples.subarray(i, Math.min(samples.length, i + 1600)));
  const none = (skipped: AsrOutcome['skipped']): AsrOutcome => ({ text: '', segments: 0, computeMs: 0, skipped });

  // 短すぎる録音と無音の判定（REC-5）
  if ((samples.length / SR) * 1000 < o.minRecordingMs) return none('too-short');
  const stats = seg.stats();
  if (stats.peak < 0.0005) return none('silent');
  if (isNoSpeechByLevel(stats, { silenceDetection: o.silenceDetection, engine: o.engine ?? 'whisper' })) return none('no-speech');

  const timeoutMs = o.timeoutMs ?? 120_000;
  let computeMs = 0;
  const run = async (audio: Float32Array, prompt: string | undefined, whole = false) => {
    const t0 = Date.now();
    // アプリと同じく、丸ごとの書き起こしでは任意の指定をすべて付け、区間ごとの書き起こしではプロンプトの組み立てだけを使う
    const build = (hints: string[]): TranscribeOptions => {
      const extras = whole
        ? asrRequestExtras(o.asr ?? {}, hints, prompt)
        : { promptText: asrRequestExtras({ promptStyle: o.asr?.promptStyle, promptTerms: o.asr?.promptTerms }, hints, prompt).promptText };
      return { language: o.language, hints, prompt, timeoutMs, ...extras };
    };
    const res =
      o.hintMode === 'selective' && o.hints.length ? await transcribeSelective((opts) => asr.transcribe(audio, opts), build(o.hints), build([])) : await asr.transcribe(audio, build(o.hints));
    computeMs += Date.now() - t0;
    return res;
  };

  // whisper の窓（30 秒）に収まる長さなら、区切りを使わずに丸ごと書き起こす
  if (!o.incremental || !cuts.length || samples.length <= WHOLE_MAX_SEC * SR) {
    const res = await run(samples, o.prompt, true);
    const uncertain = uncertainOf(res);
    return {
      text: res.text.trim(),
      tokens: res.tokens,
      segments: 1,
      hintsUsed: res.hintsUsed,
      hintsGiven: res.hintsGiven,
      computeMs,
      ...(uncertain.length ? { uncertain } : {}),
    };
  }
  // 長い録音は、区切りごとに順に書き起こす。前の区切りの末尾を prompt に渡す
  const texts: string[] = [];
  for (const [s, e] of cuts) {
    const res = await run(seg.slice(s, e), texts[texts.length - 1]?.slice(-200) || undefined);
    texts.push(res.text);
  }
  const tail = seg.slice(seg.lastCut);
  let tailText = '';
  if (tail.length > SR * 0.3 && seg.hasPendingSpeech) {
    tailText = (await run(tail, texts[texts.length - 1]?.slice(-200))).text;
  }
  return { text: joinTexts([...texts, tailText], o.language), segments: cuts.length + 1, computeMs };
}

/** 段階ごとの文 */
export interface StageTexts {
  /** 書き起こしの生の出力 */
  asr: string;
  /** 辞書の読みとの照合の後（LLM を使わないときに置き換えた文） */
  match: string;
  /** 語ごとの補正と正規化の後。LLM を使わないときに入力される文 */
  noLlm: string;
  /** LLM の整形の後。入力される文（LLM を使わない実行では noLlm と同じ） */
  final: string;
}

export interface StagesInput {
  rawText: string;
  tokens?: [string, number][];
  /** 聞き違いかもしれない箇所（書き起こしの結果から） */
  uncertain?: readonly Uncertain[];
  settings: PostAsrSettings;
  customizations: PostAsrCustomizations;
  vocab: () => { context: HintContext; recent: RecentText[]; now?: number };
  tokenizer: Tokenizer | null;
  /** null なら LLM を使わない */
  provider: LlmProvider | null;
}

export interface StagesOutput {
  stages: StageTexts;
  /** LLM を使わない経路の結果。書き起こしが空なら null */
  noLlm: PostAsrResult | null;
  /** LLM を使う経路の結果。LLM を使わない実行か、書き起こしが空なら null */
  llm: PostAsrResult | null;
}

/**
 * 書き起こしの後の処理を、LLM を使わない経路と使う経路の両方で通し、段階ごとの文を返す。
 * どちらもアプリと同じ postAsr を呼ぶ（LLM を使わない経路は、アプリで LLM が未設定のときと同じ動き）
 */
export async function postAsrStages(input: StagesInput): Promise<StagesOutput> {
  const rawText = input.rawText.trim();
  // 書き起こしが空なら、アプリは何も入力しない
  if (!rawText) return { stages: { asr: '', match: '', noLlm: '', final: '' }, noLlm: null, llm: null };
  const base = {
    mode: 'dictation' as const,
    rawText,
    confidence: charConfidence(rawText, input.tokens),
    uncertain: input.uncertain,
    settings: input.settings,
    customizations: input.customizations,
    ctx: null,
    vocab: input.vocab,
    tokenizer: () => input.tokenizer,
  };
  const noLlm = await postAsr({ ...base, provider: null });
  const llm = input.provider ? await postAsr({ ...base, provider: input.provider }) : null;
  return {
    stages: { asr: rawText, match: noLlm.matchedText, noLlm: noLlm.fmt.text, final: (llm ?? noLlm).fmt.text },
    noLlm,
    llm,
  };
}
