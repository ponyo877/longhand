/**
 * 書き起こしの後の処理。辞書の読みとの照合、語ごとの補正（textfix）、確信度の対応付け、整形（LLM）を順にかける。
 *
 * アプリ（DictationController）と評価（src/main/eval）が同じ関数を通るように、ここに切り出してある。
 * 評価がアプリと違う条件で動くと、数値が実際の精度とずれるためである。
 * 状態は持たない。保存先、LLM、単語分割は引数で受け取り、electron は読み込まない。
 */
import type { ContextPayload } from '../../shared/protocol';
import type { Settings } from '../../shared/settings';
import { formatText, type FormatInput, type FormatOutput } from '../format/Formatter';
import type { PromptContext, UncertainSpan } from '../format/prompts';
import type { LlmProvider } from '../llm/types';
import type { PreparedFormatting, PrepareOptions } from '../store/customizations';
import { fixText, type FixOutput, type Tokenizer } from '../textfix';
import { LOW_CONFIDENCE, minContentConfidence, realign, type Confidence } from '../textfix/align';
import type { HintContext, RecentText } from '../vocab/hints';

/** ターミナル。選択範囲を編集対象にせず（CTX-7）、整形は確実にコード向けにする */
export const TERMINAL_BUNDLES = new Set([
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'net.kovidgoyal.kitty',
  'com.mitchellh.ghostty',
  'io.alacritty',
  'org.alacritty',
  'com.github.wez.wezterm',
  'co.zeit.hyper',
  'org.tabby',
]);

/** 設定のうち、書き起こしの後の処理が見る項目 */
export type PostAsrSettings = Pick<Settings, 'language' | 'sendAppContext' | 'sendFieldContext' | 'llmFastPath' | 'textFix'> &
  Partial<Pick<Settings, 'formatRules' | 'formatGuard' | 'formatUncertain'>> & {
    llm: Pick<Settings['llm'], 'timeoutMs' | 'maxOutputTokens'>;
  };

/** 辞書と置換の保存先のうち、ここで使う部分（CustomizationsStore がそのまま渡せる） */
export interface PostAsrCustomizations {
  /** 置換のきっかけの語句（言い換えさせない語として使う）と、利用者の指示 */
  get(): { replacements: readonly { from: string }[]; customInstructions: string };
  vocabulary(): string[];
  prepareFormatting(rawText: string, opts: PrepareOptions): PreparedFormatting;
}

export interface PostAsrLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface PostAsrInput {
  mode: 'dictation' | 'edit';
  /** 書き起こしの生の出力（前後の空白を除いたもの） */
  rawText: string;
  /** rawText の文字ごとの確信度。録音を丸ごと書き起こしたときだけある */
  confidence?: Confidence | null;
  /** 音声認識が聞き違えたかもしれない箇所と別候補（asr/requestOptions の uncertainOf）。整形の規則が v2 のときに LLM に渡す */
  uncertain?: readonly UncertainSpan[];
  settings: PostAsrSettings;
  customizations: PostAsrCustomizations;
  /** 入力先の文脈。取れなかったら null */
  ctx: ContextPayload | null;
  /** 辞書の語に得点を付けるための文脈（入力先と最近の書き起こし）。音声入力のときだけ呼ぶ。now は評価が結果を固定するために渡す */
  vocab: () => { context: HintContext; recent: RecentText[]; now?: number };
  /** null なら LLM を使わない（skipLlm、未設定） */
  provider: LlmProvider | null;
  /** textfix の単語分割。読み込み中か使えなければ null を返す */
  tokenizer?: () => Tokenizer | null;
  signal?: AbortSignal;
  /** 件数だけを記録する（本文は渡さない） */
  log?: PostAsrLog;
  /** 整形（LLM）を始める直前に呼ぶ。呼び出し側が、照合と補正の結果を先に受け取るためのもの */
  onPlan?: (plan: PostAsrPlan) => void;
}

/** 整形の前までに決まること */
export interface PostAsrPlan {
  /** 辞書の読みとの照合の結果。音声入力でなければ null */
  prep: PreparedFormatting | null;
  /** 照合の後の文（textfix と整形に渡す文）。LLM を使うときは生テキストのまま */
  matchedText: string;
  /** 語ごとの補正の結果。動かさなかったら null */
  fix: FixOutput | null;
  /** 中身の字の確信度の最小値。確信度がなければ null */
  minConfidence: number | null;
  /** 確信度の低い字がある（近道に入れずに LLM に回す） */
  lowConfidence: boolean;
  /** formatText に渡す入力 */
  format: FormatInput;
}

export interface PostAsrResult extends PostAsrPlan {
  fmt: FormatOutput;
}

/**
 * 書き起こしの語ごとの補正（textfix）をかける。日本語の音声入力で、設定のどれかの規則がオンのときだけ動く。
 * 利用者の辞書の語、置換のきっかけ、辞書照合の候補の範囲には触らない。失敗しても音声入力は止めない（null を返す）
 */
function runTextFix(
  input: PostAsrInput,
  text: string,
  candidates: readonly { heard: string }[],
  replacementFroms: string[],
  confidence: Confidence | null,
  keptPhrases: readonly string[] = [],
): FixOutput | null {
  const cfg = input.settings;
  const ctx = input.ctx;
  const tf = cfg.textFix;
  if (!tf?.enabled || cfg.language !== 'ja') return null;
  const rules = { latin: tf.latin, fillers: tf.fillers, notation: tf.notation, particles: tf.particles };
  if (!Object.values(rules).some(Boolean)) return null;
  const started = performance.now();
  try {
    const vocabulary = input.customizations.vocabulary();
    let tokenizer: Tokenizer | null = null;
    try {
      tokenizer = input.tokenizer?.() ?? null;
    } catch {
      tokenizer = null;
    }
    const out = fixText({
      text,
      language: 'ja',
      rules,
      protectedPhrases: [...vocabulary, ...replacementFroms, ...candidates.map((c) => c.heard), ...keptPhrases],
      vocabulary,
      app: ctx ? { bundleId: ctx.app.bundleId, name: ctx.app.name, host: ctx.host } : undefined,
      blocked: tf.blocked,
      tokenizer,
      confidence,
    });
    // 長い録音では確信度が取れないので、その理由で飛ばした規則は記録しない
    const skipped = out.skipped.filter((x) => !x.endsWith('no-confidence'));
    if (out.edits.length || out.candidates.length || skipped.length) {
      const byRule = new Map<string, number>();
      for (const e of out.edits) byRule.set(e.rule, (byRule.get(e.rule) ?? 0) + 1);
      const parts = [...byRule].map(([r, n]) => `${r} ${n}`).join('、');
      // 本文は残さず、数だけを記録する
      input.log?.info(
        `自動修正: ${out.edits.length} か所${parts ? `（${parts}）` : ''}、候補 ${out.candidates.length} 件` +
          `${skipped.length ? `、飛ばした規則 ${skipped.join(' / ')}` : ''}、${(performance.now() - started).toFixed(1)}ms`,
      );
    }
    return out;
  } catch (e) {
    input.log?.warn(`自動修正に失敗しました（そのまま続けます）: ${(e as Error).message}`);
    return null;
  }
}

/**
 * 整形の前までを決める（同期）。照合、補正、確信度の対応付けを行い、formatText に渡す入力を組み立てる。
 * LLM は呼ばない。
 */
export function planPostAsr(input: PostAsrInput): PostAsrPlan {
  const { mode, rawText, ctx, provider } = input;
  const cfg = input.settings;
  const custom = input.customizations.get();
  const promptCtx: PromptContext = {};
  if (ctx && cfg.sendAppContext) {
    promptCtx.appName = ctx.app.name;
    promptCtx.host = ctx.host;
    promptCtx.field = ctx.field?.description;
  }
  if (ctx?.field && !ctx.field.isSecure && cfg.sendFieldContext) {
    promptCtx.beforeCursor = ctx.field.beforeCursor;
    promptCtx.afterCursor = ctx.field.afterCursor;
  }
  // 辞書の語との照合（G4-10、G4-11）。LLM を使うなら候補を整形に渡し、使わないなら確かめた読みだけを置き換える。
  // 履歴の rawText には、置き換える前の書き起こしを残す
  const prep = mode === 'dictation' ? input.customizations.prepareFormatting(rawText, { useLlm: !!provider, ...input.vocab() }) : null;
  // 書き起こしの語ごとの補正（textfix）。直した文は LLM を通さない経路で使い、LLM には直す前の文と候補を渡す
  const matchedText = prep?.text ?? rawText;
  const confidence = mode === 'dictation' && input.confidence ? realign(rawText, input.confidence, matchedText) : null;
  const replacementFroms = custom.replacements.map((r) => r.from);
  // 利用者が元に戻した語句は、語ごとの補正でも書き換えない
  const keptPhrases = (prep?.kept ?? []).map((k) => k.phrase);
  const fix = mode === 'dictation' ? runTextFix(input, matchedText, prep?.candidates ?? [], replacementFroms, confidence, keptPhrases) : null;
  // 確信度の低い字がある発話は、近道に入れずに LLM に回す（聞き違いがありそうなため。自動修正の設定とは関係なく動く）
  const minConfidence = minContentConfidence(matchedText, confidence);
  const lowConfidence = minConfidence !== null && minConfidence < LOW_CONFIDENCE;
  if (lowConfidence && provider && cfg.llmFastPath) {
    input.log?.info(`確信度の低い字があるので、近道に入れずに LLM に回します（最小 ${minConfidence.toFixed(2)}）`);
  }
  // 出力の検査で、読みが同じ置き換えを見分けるための単語分割（検査がオフなら読み込まない）
  const guard = cfg.formatGuard ?? 'off';
  let guardTokenizer: Tokenizer | null = null;
  if (guard !== 'off') {
    try {
      guardTokenizer = input.tokenizer?.() ?? null;
    } catch {
      guardTokenizer = null;
    }
  }
  const format: FormatInput = {
    mode,
    rawText: matchedText,
    promptVersion: cfg.formatRules ?? 'v1',
    uncertain: mode === 'dictation' ? input.uncertain : undefined,
    useUncertain: cfg.formatUncertain ?? false,
    guard,
    tokenizer: guardTokenizer,
    language: cfg.language === 'auto' ? 'auto' : cfg.language,
    context: promptCtx,
    selectedText: mode === 'edit' ? ctx?.field?.selectedText : undefined,
    vocabulary: prep?.vocabulary ?? input.customizations.vocabulary(),
    dictionaryCandidates: prep?.candidates,
    learned: prep ? { misheard: prep.misheard, kept: prep.kept, hasCorrections: prep.hasCorrections, numberStyle: prep.numberStyle } : undefined,
    pastCorrections: prep?.corrections,
    textFix: fix ?? undefined,
    lowConfidence: lowConfidence || undefined,
    customInstructions: custom.customInstructions,
    // 置換の対象の語は、LLM に言い換えさせない
    protectedPhrases: replacementFroms,
    // ターミナルなら確実にコード向けにする。ほかはアプリ名から推定させる（undefined）
    codeLike: ctx && TERMINAL_BUNDLES.has(ctx.app.bundleId) ? true : undefined,
    fastPath: cfg.llmFastPath,
    provider,
    timeoutMs: cfg.llm.timeoutMs,
    maxOutputTokens: cfg.llm.maxOutputTokens,
    signal: input.signal,
  };
  return { prep, matchedText, fix, minConfidence, lowConfidence, format };
}

/** 書き起こしの後の処理を通しで行う。LLM の失敗は例外にせず、fmt.error に入れて返す（formatText と同じ） */
export async function postAsr(input: PostAsrInput): Promise<PostAsrResult> {
  const plan = planPostAsr(input);
  input.onPlan?.(plan);
  const fmt = await formatText(plan.format);
  return { ...plan, fmt };
}
