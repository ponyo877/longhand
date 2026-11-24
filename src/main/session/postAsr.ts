/**
 * Processing after transcription: matching against dictionary readings, per-word fixes (textfix), mapping confidence, and formatting (LLM), in that order.
 *
 * It lives here so that the app (DictationController) and the evaluation (src/main/eval) run through the same function.
 * If the evaluation ran under different conditions from the app, its numbers would drift from the real accuracy.
 * It holds no state. The stores, the LLM and the tokenizer come in as arguments, and electron is not loaded.
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

/** Terminals. The selection is never an edit target (CTX-7), and formatting is always for code */
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

/** The settings that processing after transcription reads */
export type PostAsrSettings = Pick<Settings, 'language' | 'sendAppContext' | 'sendFieldContext' | 'llmFastPath' | 'textFix'> &
  Partial<Pick<Settings, 'formatRules' | 'formatGuard' | 'formatUncertain'>> & {
    llm: Pick<Settings['llm'], 'timeoutMs' | 'maxOutputTokens'>;
  };

/** The parts of the dictionary and replacement store used here (a CustomizationsStore can be passed as it is) */
export interface PostAsrCustomizations {
  /** Replacement trigger phrases (used as words not to be reworded) and the user's instructions */
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
  /** Raw transcription output (with leading and trailing whitespace removed) */
  rawText: string;
  /** Per-character confidence of rawText. Present only when the whole recording was transcribed at once */
  confidence?: Confidence | null;
  /** Spots speech recognition may have misheard, with alternatives (uncertainOf in asr/requestOptions). Passed to the LLM when the formatting rules are v2 */
  uncertain?: readonly UncertainSpan[];
  settings: PostAsrSettings;
  customizations: PostAsrCustomizations;
  /** Context of the input target. null if it could not be read */
  ctx: ContextPayload | null;
  /** Context for scoring dictionary words (the input target and recent transcripts). Called only for dictation. The evaluation passes now to make results repeatable */
  vocab: () => { context: HintContext; recent: RecentText[]; now?: number };
  /** null means no LLM (skipLlm, or not set up) */
  provider: LlmProvider | null;
  /** Tokenizer for textfix. Returns null while loading or when unavailable */
  tokenizer?: () => Tokenizer | null;
  signal?: AbortSignal;
  /** Logs counts only (the text is never passed) */
  log?: PostAsrLog;
  /** Called right before formatting (LLM) starts, so that the caller gets the matching and fix results first */
  onPlan?: (plan: PostAsrPlan) => void;
}

/** What is decided before formatting */
export interface PostAsrPlan {
  /** Result of matching against dictionary readings. null when not dictating */
  prep: PreparedFormatting | null;
  /** Text after matching (the text passed to textfix and formatting). The raw text as is when the LLM is used */
  matchedText: string;
  /** Result of the per-word fixes. null if they did not run */
  fix: FixOutput | null;
  /** Lowest confidence of the content characters. null without confidence */
  minConfidence: number | null;
  /** Some characters have low confidence (send to the LLM instead of the fast path) */
  lowConfidence: boolean;
  /** Input passed to formatText */
  format: FormatInput;
}

export interface PostAsrResult extends PostAsrPlan {
  fmt: FormatOutput;
}

/**
 * Applies the per-word fixes (textfix) to the transcript. Runs only for Japanese dictation with at least one rule on in the settings.
 * Leaves the user's dictionary words, replacement triggers and dictionary match candidates alone. A failure never stops dictation (returns null)
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
    // Long recordings have no confidence, so rules skipped for that reason are not logged
    const skipped = out.skipped.filter((x) => !x.endsWith('no-confidence'));
    if (out.edits.length || out.candidates.length || skipped.length) {
      const byRule = new Map<string, number>();
      for (const e of out.edits) byRule.set(e.rule, (byRule.get(e.rule) ?? 0) + 1);
      const parts = [...byRule].map(([r, n]) => `${r} ${n}`).join(', ');
      // Log counts only, never the text
      input.log?.info(
        `textfix: edits=${out.edits.length}${parts ? ` (${parts})` : ''}, candidates=${out.candidates.length}` +
          `${skipped.length ? `, skipped rules ${skipped.join(' / ')}` : ''}, ${(performance.now() - started).toFixed(1)}ms`,
      );
    }
    return out;
  } catch (e) {
    input.log?.warn(`textfix failed (continuing without it): ${(e as Error).message}`);
    return null;
  }
}

/**
 * Decides everything up to formatting (synchronously). Runs matching, fixes and confidence mapping, and builds the input for formatText.
 * Does not call the LLM.
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
  // Matching against dictionary words (G4-10, G4-11). With the LLM, the candidates go to formatting; without it, only confirmed readings are replaced.
  // rawText in the history keeps the transcript from before the replacement
  const prep = mode === 'dictation' ? input.customizations.prepareFormatting(rawText, { useLlm: !!provider, ...input.vocab() }) : null;
  // Per-word fixes (textfix). The fixed text is used on the path without the LLM; the LLM gets the text before the fixes, with candidates
  const matchedText = prep?.text ?? rawText;
  const confidence = mode === 'dictation' && input.confidence ? realign(rawText, input.confidence, matchedText) : null;
  const replacementFroms = custom.replacements.map((r) => r.from);
  // Phrases the user changed back are not rewritten by the per-word fixes either
  const keptPhrases = (prep?.kept ?? []).map((k) => k.phrase);
  const fix = mode === 'dictation' ? runTextFix(input, matchedText, prep?.candidates ?? [], replacementFroms, confidence, keptPhrases) : null;
  // An utterance with low-confidence characters goes to the LLM instead of the fast path (it is likely misheard; this works regardless of the textfix settings)
  const minConfidence = minContentConfidence(matchedText, confidence);
  const lowConfidence = minConfidence !== null && minConfidence < LOW_CONFIDENCE;
  if (lowConfidence && provider && cfg.llmFastPath) {
    input.log?.info(`low-confidence characters, sending to the LLM instead of the fast path (min ${minConfidence.toFixed(2)})`);
  }
  // Tokenizer for the output check, to tell replacements with the same reading apart (not loaded when the check is off)
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
    // The LLM must not reword replacement targets
    protectedPhrases: replacementFroms,
    // Always format for code in a terminal. Elsewhere, let it guess from the app name (undefined)
    codeLike: ctx && TERMINAL_BUNDLES.has(ctx.app.bundleId) ? true : undefined,
    fastPath: cfg.llmFastPath,
    provider,
    timeoutMs: cfg.llm.timeoutMs,
    maxOutputTokens: cfg.llm.maxOutputTokens,
    signal: input.signal,
  };
  return { prep, matchedText, fix, minConfidence, lowConfidence, format };
}

/** Runs the whole processing after transcription. An LLM failure does not throw but comes back in fmt.error (as in formatText) */
export async function postAsr(input: PostAsrInput): Promise<PostAsrResult> {
  const plan = planPostAsr(input);
  input.onPlan?.(plan);
  const fmt = await formatText(plan.format);
  return { ...plan, fmt };
}
