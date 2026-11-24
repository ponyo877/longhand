import { t } from '../i18n';
import type { LlmProvider } from '../llm/types';
import { LlmError } from '../llm/types';
import {
  DICTATION_SCHEMA,
  EDIT_SCHEMA,
  dictationSystemPrompt,
  dictationUserMessage,
  editSystemPrompt,
  editUserMessage,
  type DictionaryCandidate,
  type LearnedHints,
  type PastCorrectionHint,
  type PromptContext,
  type PromptVersion,
  type UncertainSpan,
} from './prompts';
import type { FixEdit, LexiconCandidate, Tokenizer } from '../textfix/types';
import { needsLlm } from './fastPath';
import { inspectFormatting, type GuardCheck, type HunkKind } from './guards';
import { applyNumberStyle } from './numberStyle';
import { hasSubstance, isCodeLikeApp, looksLikeAnswer, normalizeText, parseJsonObject } from './postprocess';

export interface FormatInput {
  mode: 'dictation' | 'edit';
  rawText: string;
  language: string;
  context: PromptContext;
  /** Selected text in edit mode */
  selectedText?: string;
  vocabulary: string[];
  customInstructions: string;
  /** Replacement trigger phrases. Passed in the prompt so the LLM does not reword them (the replacement itself happens at paste time) */
  protectedPhrases?: string[];
  /** Candidates where part of the raw text may refer to a dictionary word (G4-11). Passed in the user message */
  dictionaryCandidates?: DictionaryCandidate[];
  /** What was learned from the user's corrections (misheard forms, phrases not to rewrite). Goes into the system prompt */
  learned?: LearnedHints;
  /** Past mix-up pairs that appear in the raw text. Passed in the user message. If there are any, the fast path is not taken */
  pastCorrections?: readonly PastCorrectionHint[];
  /** Whether the target is a terminal or code editor. Guessed from the app name if unset (decides whether spaces between Japanese and Latin text are removed) */
  codeLike?: boolean;
  /** Skip the LLM for short, clean utterances (N6, the llmFastPath setting) */
  fastPath?: boolean;
  /**
   * Result of word-level transcript fixes (textfix). Paths that skip the LLM (no LLM, fast path, LLM failure) use the fixed text.
   * The LLM gets the transcript before fixing, with the words turned into Latin letters and the glossary candidates attached as lexicon_candidates
   */
  textFix?: { text: string; edits: readonly FixEdit[]; candidates: readonly LexiconCandidate[] };
  /** Some characters have low recognition confidence. Skip the fast path and send to the LLM (llmReason low-confidence) */
  lowConfidence?: boolean;
  /** Version of the formatting rules (v1 by default) */
  promptVersion?: PromptVersion;
  /** Spots speech recognition may have misheard, with alternatives. Passed to the LLM with the v2 rules or when useUncertain is set. When passed, the fast path is not taken */
  uncertain?: readonly UncertainSpan[];
  /** Pass uncertain to the LLM to choose from even with the v1 rules (the formatUncertain setting) */
  useUncertain?: boolean;
  /**
   * Checks on the LLM output (guards.ts). off: none. shadow: check and only return the result (the output is unchanged).
   * enforce: revert unsupported rewrites to the text before formatting, and use the text before formatting if changes in numbers, negation and so on remain
   */
  guard?: GuardMode;
  /** Tokenizer for spotting replacements with the same reading during the checks (that check is skipped without it) */
  tokenizer?: Tokenizer | null;
  /** null means the LLM is not used (skipLlm, not configured) */
  provider: LlmProvider | null;
  timeoutMs: number;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export type GuardMode = 'off' | 'shadow' | 'enforce';

/** Result of the output checks (no text, only counts and the kinds of problems found) */
export interface GuardSummary {
  mode: GuardMode;
  /** Number of diff hunks per kind */
  counts: Record<HunkKind, number>;
  /** Problems found */
  violations: GuardCheck[];
  /** How enforce changed the output. none: unchanged, repaired: reverted only the unsupported hunks, fallback: used the text before formatting */
  action: 'none' | 'repaired' | 'fallback';
}

export interface FormatOutput {
  text: string;
  /** Whether the text counts as formatted. true when the LLM formatted it, or when the fast path decided the LLM was not needed */
  formatted: boolean;
  /** Took the fast path and did not call the LLM */
  fastPath?: boolean;
  /** The pasted text is the textfix output (the history keeps the fixes) */
  autoFixed?: boolean;
  /** Why the attempt to use the LLM failed */
  error?: string;
  errorKind?: string;
  deleted?: boolean;
  unclear?: boolean;
  llmMs: number;
  model?: string;
  /** Result of the output checks (when guard is not off and the LLM output was checked) */
  guard?: GuardSummary;
  /** LLM output before the checks (after normalization). Returned so evaluation can judge whether the checks were right */
  llmText?: string;
}

/**
 * The layer that decides what to ask for. Handles building the prompt, validating the output and falling back on failure.
 * Where to ask (HTTP format and authentication) is LlmProvider's job.
 */
export async function formatText(input: FormatInput): Promise<FormatOutput> {
  const raw = input.rawText.trim();
  const protectedPhrases = input.protectedPhrases ?? [];

  if (input.mode === 'dictation') {
    const codeLike = input.codeLike ?? isCodeLikeApp(input.context.appName);
    const normalize = (s: string) => normalizeText(s, { language: input.language, codeLike });
    // The user's number notation is applied to whatever text is inserted. Not in terminals and code editors, where digits are code
    const numberStyle = codeLike ? undefined : input.learned?.numberStyle;
    const finish = (o: FormatOutput): FormatOutput => (numberStyle && o.text ? { ...o, text: applyNumberStyle(o.text, numberStyle) } : o);
    // Paths that skip the LLM use the textfix output
    const fix = input.textFix;
    const version = input.promptVersion ?? 'v1';
    // Pass disagreeing spots to the LLM only with the v2 rules or when the setting is on
    const passUncertain = version === 'v2' || !!input.useUncertain;
    const uncertain = passUncertain ? (input.uncertain ?? []) : [];
    const fixedRaw = fix && fix.edits.length ? fix.text.trim() : raw;
    const autoFixed = fixedRaw !== raw || undefined;
    const fallback = normalize(fixedRaw);
    if (!raw || !hasSubstance(raw) || !fixedRaw) return finish({ text: '', formatted: false, llmMs: 0 });
    if (!input.provider) return finish({ text: fallback, formatted: false, llmMs: 0, autoFixed });
    // Treat words turned into Latin letters as known words, and let the LLM decide on glossary candidates that were not fixed
    const fixedWords = (fix?.edits ?? []).filter((e) => e.rule === 'latin').map((e) => e.after.trim());
    if (
      input.fastPath &&
      !needsLlm(fallback, {
        mode: 'dictation',
        language: input.language,
        customInstructions: input.customInstructions,
        protectedPhrases,
        vocabulary: fixedWords.length ? [...input.vocabulary, ...fixedWords] : input.vocabulary,
        // Past mix-up pairs also count as candidates to judge from context
        dictionaryCandidates: [...(input.dictionaryCandidates ?? []), ...(fix?.candidates ?? []), ...(input.pastCorrections ?? [])],
        lowConfidence: input.lowConfidence || uncertain.length > 0,
        beforeCursor: input.context.beforeCursor,
        afterCursor: input.context.afterCursor,
      })
    ) {
      return finish({ text: fallback, formatted: true, fastPath: true, llmMs: 0, autoFixed });
    }
    const lexicon = [...(fix?.edits ?? []).filter((e) => e.rule === 'latin').map((e) => ({ heard: e.before, word: e.after.trim() })), ...(fix?.candidates ?? [])];
    const started = Date.now();
    try {
      const res = await input.provider.complete({
        system: dictationSystemPrompt(input.vocabulary, input.customInstructions, protectedPhrases, version, {
          ...input.learned,
          // The v2 rules already explain uncertain. With v1, add the explanation only when passing it
          explainUncertain: version === 'v1' && !!input.useUncertain,
        }),
        user: dictationUserMessage(raw, input.language, input.context, input.dictionaryCandidates, lexicon, uncertain, input.pastCorrections),
        jsonSchema: DICTATION_SCHEMA as unknown as Record<string, unknown>,
        maxOutputTokens: Math.max(256, Math.min(input.maxOutputTokens, raw.length * 4 + 256)),
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });
      const llmMs = Date.now() - started;
      const parsed = parseJsonObject(res.text);
      const text = typeof parsed?.text === 'string' ? parsed.text : parsed ? null : res.text;
      if (text === null) {
        return finish({ text: fallback, formatted: false, error: t('text.format.unparseable'), errorKind: 'parse', llmMs, model: res.model, autoFixed });
      }
      const cleaned = normalize(text);
      if (!cleaned && normalizeLen(raw) > 8) {
        return finish({ text: fallback, formatted: false, error: t('text.format.emptyResult'), errorKind: 'guard', llmMs, model: res.model, autoFixed });
      }
      if (cleaned && looksLikeAnswer(raw, cleaned)) {
        return finish({
          text: fallback,
          formatted: false,
          error: t('text.format.strayedFromTranscript'),
          errorKind: 'guard',
          llmMs,
          model: res.model,
          autoFixed,
        });
      }
      const guardMode = input.guard ?? 'off';
      if (guardMode !== 'off' && cleaned) {
        // Words that support a replacement: dictionary, match candidates, glossary candidates, words turned into Latin letters, alternatives
        const evidence = [
          ...input.vocabulary,
          ...(input.dictionaryCandidates ?? []).map((c) => c.word),
          ...lexicon.map((c) => c.word),
          ...uncertain.flatMap((u) => [...u.alternatives]),
          ...(input.pastCorrections ?? []).map((c) => c.corrected),
        ];
        const opts = { evidence, tokenizer: input.tokenizer ?? null };
        const report = inspectFormatting(fallback, cleaned, opts);
        const guard: GuardSummary = { mode: guardMode, counts: report.counts, violations: report.violations.map((v) => v.check), action: 'none' };
        if (guardMode === 'shadow' || (!report.violations.length && report.repaired === cleaned)) {
          return finish({ text: cleaned, formatted: true, llmMs, model: res.model, guard, llmText: cleaned });
        }
        // Use the text with only the unsupported hunks reverted if no problems remain. Otherwise, use the text before formatting
        const repaired = normalize(report.repaired);
        const again = inspectFormatting(fallback, repaired, opts);
        if (!again.violations.length) {
          return finish({ text: repaired, formatted: true, llmMs, model: res.model, guard: { ...guard, action: 'repaired' }, llmText: cleaned });
        }
        return finish({ text: fallback, formatted: true, llmMs, model: res.model, autoFixed, guard: { ...guard, action: 'fallback' }, llmText: cleaned });
      }
      return finish({ text: cleaned, formatted: true, llmMs, model: res.model });
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError('network', (e as Error).message);
      return finish({ text: fallback, formatted: false, error: err.message, errorKind: err.kind, llmMs: Date.now() - started, autoFixed });
    }
  }

  // Edit mode. Nothing is pasted on failure (the caller checks error)
  const selected = input.selectedText ?? '';
  if (!raw || !hasSubstance(raw)) return { text: '', formatted: false, unclear: true, llmMs: 0 };
  if (!input.provider) {
    return { text: '', formatted: false, error: t('text.format.editNeedsLlm'), errorKind: 'config', llmMs: 0 };
  }
  const started = Date.now();
  try {
    const res = await input.provider.complete({
      system: editSystemPrompt(input.vocabulary, input.customInstructions, protectedPhrases),
      user: editUserMessage(selected, raw, input.language, input.context),
      jsonSchema: EDIT_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: Math.max(512, Math.min(16000, selected.length * 4 + raw.length * 2 + 512)),
      timeoutMs: Math.max(input.timeoutMs, 10000),
      signal: input.signal,
    });
    const llmMs = Date.now() - started;
    const parsed = parseJsonObject(res.text);
    if (!parsed || typeof parsed.text !== 'string') {
      return { text: '', formatted: false, error: t('text.format.unparseable'), errorKind: 'parse', llmMs, model: res.model };
    }
    const deleted = parsed.deleted === true;
    // An empty text without a delete instruction counts as an unclear instruction (do not paste nothing. N5)
    const unclear = parsed.unclear === true || (!deleted && !parsed.text.trim());
    return {
      text: unclear ? '' : parsed.text,
      formatted: true,
      deleted: deleted && !unclear,
      unclear,
      llmMs,
      model: res.model,
    };
  } catch (e) {
    const err = e instanceof LlmError ? e : new LlmError('network', (e as Error).message);
    return { text: '', formatted: false, error: err.message, errorKind: err.kind, llmMs: Date.now() - started };
  }
}

function normalizeLen(s: string): number {
  return s.replace(/[\s、。,.!?！？]/g, '').length;
}
