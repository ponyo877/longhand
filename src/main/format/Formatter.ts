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
  /** 編集モードの選択テキスト */
  selectedText?: string;
  vocabulary: string[];
  customInstructions: string;
  /** 置換のきっかけの語句。LLM に言い換えさせないようにプロンプトで渡す（置換そのものは貼り付けのときに行う） */
  protectedPhrases?: string[];
  /** 生テキストの一部が辞書の語を指しているかもしれない、という候補（G4-11）。ユーザーメッセージで渡す */
  dictionaryCandidates?: DictionaryCandidate[];
  /** 利用者の手直しから覚えたこと（聞き違えた形、書き換えない語句）。システムプロンプトに入れる */
  learned?: LearnedHints;
  /** 生テキストに出ている、以前の取り違えの組。ユーザーメッセージで渡す。あれば近道に入れない */
  pastCorrections?: readonly PastCorrectionHint[];
  /** 入力先がターミナルかコードエディタか。未指定ならアプリ名から推定する（和英間の空白を詰めるかどうかに使う） */
  codeLike?: boolean;
  /** 整った短い発話は LLM を飛ばす（N6、設定の llmFastPath） */
  fastPath?: boolean;
  /**
   * 書き起こしの語ごとの補正（textfix）の結果。LLM を通さない経路（LLM なし、近道、LLM の失敗）では直した文を使う。
   * LLM には直す前の書き起こしを渡し、英字に直した語と用語集の候補を lexicon_candidates として添える
   */
  textFix?: { text: string; edits: readonly FixEdit[]; candidates: readonly LexiconCandidate[] };
  /** 音声認識の確信度の低い字がある。近道に入れずに LLM に回す（llmReason の low-confidence） */
  lowConfidence?: boolean;
  /** 整形の規則の版（既定は v1） */
  promptVersion?: PromptVersion;
  /** 音声認識が聞き違えたかもしれない箇所と、その別候補。v2 の規則か、useUncertain のときに LLM に渡す。渡すときは近道に入れない */
  uncertain?: readonly UncertainSpan[];
  /** v1 の規則でも、uncertain を LLM に渡して選ばせる（設定の formatUncertain） */
  useUncertain?: boolean;
  /**
   * LLM の出力の検査（guards.ts）。off: しない。shadow: 調べて結果を返すだけ（出力は変えない）。
   * enforce: 根拠のない書き換えを整形前の文に戻し、数や否定の変化などが残るなら整形前の文を使う
   */
  guard?: GuardMode;
  /** 検査で、読みが同じ置き換えを見分けるための単語分割（なければその判定を飛ばす） */
  tokenizer?: Tokenizer | null;
  /** null なら LLM を使わない（skipLlm、未設定） */
  provider: LlmProvider | null;
  timeoutMs: number;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export type GuardMode = 'off' | 'shadow' | 'enforce';

/** 出力の検査の結果（本文は含めない。件数と、見つかった問題の種類だけ） */
export interface GuardSummary {
  mode: GuardMode;
  /** 差分の塊の、種類ごとの数 */
  counts: Record<HunkKind, number>;
  /** 見つかった問題 */
  violations: GuardCheck[];
  /** enforce で、出力をどう変えたか。none: 変えていない、repaired: 根拠のない塊だけを戻した、fallback: 整形前の文を使った */
  action: 'none' | 'repaired' | 'fallback';
}

export interface FormatOutput {
  text: string;
  /** 整形済みとして扱えるか。LLM で整形できたとき、または近道（fastPath）で LLM が要らないと判断したとき true */
  formatted: boolean;
  /** 近道に入り、LLM を呼ばなかった */
  fastPath?: boolean;
  /** 貼る文に、textfix で直した文を使った（履歴に直した箇所を残す） */
  autoFixed?: boolean;
  /** LLM を使おうとして失敗した理由 */
  error?: string;
  errorKind?: string;
  deleted?: boolean;
  unclear?: boolean;
  llmMs: number;
  model?: string;
  /** 出力の検査の結果（guard が off でなく、LLM の出力を調べたとき） */
  guard?: GuardSummary;
  /** 検査の前の、LLM の出力（正規化の後）。評価で、検査の当たり外れを調べるために返す */
  llmText?: string;
}

/**
 * 何を頼むかを決める層。プロンプトの組み立て、出力の検証、失敗時の代替を受け持つ。
 * どこに頼むか（HTTP の形式と認証）は LlmProvider が受け持つ。
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
    // LLM を通さない経路では、textfix で直した文を使う
    const fix = input.textFix;
    const version = input.promptVersion ?? 'v1';
    // 食い違った箇所は、規則が v2 か、設定がオンのときだけ LLM に渡す
    const passUncertain = version === 'v2' || !!input.useUncertain;
    const uncertain = passUncertain ? (input.uncertain ?? []) : [];
    const fixedRaw = fix && fix.edits.length ? fix.text.trim() : raw;
    const autoFixed = fixedRaw !== raw || undefined;
    const fallback = normalize(fixedRaw);
    if (!raw || !hasSubstance(raw) || !fixedRaw) return finish({ text: '', formatted: false, llmMs: 0 });
    if (!input.provider) return finish({ text: fallback, formatted: false, llmMs: 0, autoFixed });
    // 英字に直した語は知っている語として扱い、直さなかった用語集の候補は LLM に判断させる
    const fixedWords = (fix?.edits ?? []).filter((e) => e.rule === 'latin').map((e) => e.after.trim());
    if (
      input.fastPath &&
      !needsLlm(fallback, {
        mode: 'dictation',
        language: input.language,
        customInstructions: input.customInstructions,
        protectedPhrases,
        vocabulary: fixedWords.length ? [...input.vocabulary, ...fixedWords] : input.vocabulary,
        // 以前の取り違えの組も、文脈で判断させる候補として数える
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
          // v2 の規則は、uncertain の説明を本文に持っている。v1 では、渡すときだけ説明を足す
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
        return finish({ text: fallback, formatted: false, error: 'LLM の出力を解釈できませんでした', errorKind: 'parse', llmMs, model: res.model, autoFixed });
      }
      const cleaned = normalize(text);
      if (!cleaned && normalizeLen(raw) > 8) {
        return finish({ text: fallback, formatted: false, error: 'LLM が空の結果を返しました', errorKind: 'guard', llmMs, model: res.model, autoFixed });
      }
      if (cleaned && looksLikeAnswer(raw, cleaned)) {
        return finish({
          text: fallback,
          formatted: false,
          error: 'LLM の出力が書き起こしから大きく外れたため、生テキストを使いました',
          errorKind: 'guard',
          llmMs,
          model: res.model,
          autoFixed,
        });
      }
      const guardMode = input.guard ?? 'off';
      if (guardMode !== 'off' && cleaned) {
        // 置き換えの根拠になる語: 辞書、照合の候補、用語集の候補、英字に直した語、別候補
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
        // 根拠のない塊だけを戻した文で、問題が残らなければそれを使う。残るなら、整形前の文を使う
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

  // 編集モード。失敗したら貼り付けない（呼び出し側で error を見て判断する）
  const selected = input.selectedText ?? '';
  if (!raw || !hasSubstance(raw)) return { text: '', formatted: false, unclear: true, llmMs: 0 };
  if (!input.provider) {
    return { text: '', formatted: false, error: '編集モードには LLM の設定が必要です', errorKind: 'config', llmMs: 0 };
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
      return { text: '', formatted: false, error: 'LLM の出力を解釈できませんでした', errorKind: 'parse', llmMs, model: res.model };
    }
    const deleted = parsed.deleted === true;
    // 削除の指示でないのに本文が空なら、不明確な指示として扱う（空を貼らない。N5）
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
