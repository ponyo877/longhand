/**
 * Runs an evaluation. Passes each utterance of the datasets through the same steps as the app (pipeline.ts) and compares each stage with the reference.
 *
 * Does not load electron. Can be called from tsx (scripts/eval-run.ts) and from inside the development app (LONGHAND_EVAL).
 * The LLM can be called for real only inside the app (it uses the saved connection settings and key). From tsx, it runs without the LLM or with saved results only.
 *
 * Results: <root>/runs/<date and time>-<name>/{config.json, rows.jsonl, summary.json} and <root>/runs/index.jsonl
 * - rows.jsonl contains the text of each utterance (personal transcripts). summary.json and standard output hold numbers only
 * - API keys, headers and endpoints are never written to any file
 */
import fs from 'node:fs';
import path from 'node:path';
import { deepMerge, DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import type { DeepPartial } from '../../shared/types';
import { AsrService, resolveModel } from '../asr/AsrService';
import { decodeWav } from '../audio/wav';
import type { LlmProvider } from '../llm/types';
import { redact } from '../log';
import { CustomizationsStore } from '../store/customizations';
import { createLinderaTokenizer } from '../textfix/tokenizer';
import type { Tokenizer } from '../textfix/types';
import type { RecentText } from '../vocab/hints';
import { generateReadings } from '../vocab/readings';
import { extractScreenTerms } from '../vocab/screenTerms';
import { asrCacheKey, CachingProvider, CallBudget, JsonCache, type LlmIdentity } from './cache';
import { loadDataset, loadTruth, readWordList, type DatasetCounts, type Split, type Utterance } from './datasets';
import { appendPrivate, ensurePrivateDir, fileSig, hashTree, sha256Hex, writePrivate } from './files';
import { applyLearning } from '../learn/apply';
import { learnFromEdit } from '../learn/Learner';
import { postAsrStages, transcribeLikeApp, type AsrOutcome, type Transcriber } from './pipeline';
import { bestCer, normContent } from './metrics';
import { formatCategories, formatDetail, formatGroup, scoreUtterance, summarize, type Groups, type LlmMode, type RowRecord } from './score';

/** Number of recent transcripts used to score dictionary words (same as the app's RECENT_FOR_VOCAB) */
const RECENT_FOR_VOCAB = 100;
/** LLM timeout in evaluation. Utterances over the app's timeout (8 seconds by default) are counted separately */
const EVAL_LLM_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_LLM_CALLS = 150;

/** Kinds of things learned from edits (words, misheard forms, correction pairs, phrases not to rewrite) */
export type LearnKind = 'words' | 'forms' | 'corrections' | 'kept' | 'numbers';
const LEARN_KINDS: readonly LearnKind[] = ['words', 'forms', 'corrections', 'kept', 'numbers'];

export interface EvalConfig {
  /** Name of the run (part of the result folder name) */
  name: string;
  /** Names of the datasets to measure (<root>/datasets/<name>) */
  datasets: string[];
  /** Overrides on the app's defaults (DEFAULT_SETTINGS) */
  settings?: DeepPartial<Settings>;
  /** File listing dictionary words (one word per line). No dictionary if absent */
  vocab?: string | null;
  /** Readings file (one "word<TAB>reading,reading" per line). Treated as readings the user confirmed */
  readings?: string | null;
  /** off: no LLM. live: calls the LLM (only inside the app). cache-only: uses saved results only */
  llm: LlmMode;
  /** How many times one run may call the LLM (150 by default) */
  maxLlmCalls?: number;
  /** LLM timeout in evaluation (60 seconds by default) */
  llmTimeoutMs?: number;
  /** Attempt number. Change it to call the LLM again for the same input */
  attempt?: number;
  /** Narrows the utterances */
  split?: Split | 'all';
  ids?: string[];
  limit?: number;
  /** "Recent transcripts" used to score dictionary words. previous is the references of earlier utterances in the same dataset, none is nothing (previous by default) */
  recent?: 'previous' | 'none';
  /**
   * Replaces the formatting model and its settings (for comparing models). The endpoint and key saved in the app are used as they are.
   * The replacement goes into the key of saved LLM results, so each model's results are saved separately
   */
  llmOverride?: { model?: string; anthropic?: { effort?: string; thinking?: string } };
  /**
   * Experiment that adds words picked from the screen text to the utterance's hints (in place of the app's asr.screenTerms).
   * The evaluation data has no screen text of the target field, so the reference text of the previous utterance in the same chunk
   * (utterances within 3 minutes of each other) is taken as "the text on screen".
   * In chats and terminals, the text typed just before stays on screen. The number is how many earlier utterances to look at (0 or unset adds nothing).
   * It uses reference text, so it comes out better than reality (a rough upper bound)
   */
  screenTermsFromPrevious?: number;
  /**
   * Experiment that measures the effect of learning from edits. Utterances matching train (a regular expression for utterance ids) are taken out of the measured set and run first,
   * and learning is simulated as if the user had edited their output into the reference text (through the same learnFromEdit as the app).
   * The remaining utterances are measured with what was learned. kinds narrows what is learned (all by default)
   */
  learn?: { train: string; kinds?: LearnKind[] };
  /** Uses saved results only, without running speech recognition */
  asrCacheOnly?: boolean;
  /** Prompt passed when transcribing the whole recording (experimental; the app does not pass one) */
  asrPrompt?: string;
  /**
   * Cuts the end of the audio before transcribing (experimental). For comparing the same recording "with" and "without" the audio recorded after the key was released.
   * 'postRoll' cuts each row's postRollMs (the length recorded after release). Rows without it stay as they are. A number cuts that length (ms) from every row
   */
  truncateTail?: 'postRoll' | number;
}

/** LLM connection (built inside the app from the saved settings and key) */
export interface LlmConnection {
  /** The real LLM. null when only saved results are used */
  provider: LlmProvider | null;
  identity: LlmIdentity;
  /** The output limit from the settings, and the app's timeout */
  maxOutputTokens: number;
  appTimeoutMs: number;
  /** The counter, if calls are counted at the network entry point (fetch). If not given, CachingProvider counts them */
  budget?: CallBudget;
}

export interface EvalEnv {
  /** Where the evaluation data lives (~/longhand-eval) */
  root: string;
  /** The repository (workers, the tokenizer's WASM, code hashes) */
  repoRoot: string;
  /** Folder of speech recognition models */
  modelsDir: string;
  bundledModelsDir?: string;
  llm?: LlmConnection;
  /** Replacement transcriber (for tests). If not given, the ASR worker is started */
  asr?: Transcriber;
  /** Where this runs (for the record) */
  host: string;
  print?: (line: string) => void;
}

export interface EvalSummary {
  run: string;
  name: string;
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'aborted';
  /** Why it stopped early (kind only) */
  aborted?: string;
  /** Whether it includes utterances with a provisional reference. If so, read the numbers as a provisional baseline */
  provisional: boolean;
  truth: { provisional: number; reviewed: number };
  llm: {
    mode: LlmMode;
    kind?: string;
    model?: string;
    /** How many times the LLM was actually called (including retries) */
    calls: number;
    /** Number of HTTP requests sent (only when counted at the network entry point) */
    httpRequests?: number;
    maxCalls: number;
    cacheHits: number;
    cacheMisses: number;
    stored: number;
    failures: number;
    timeoutMs: number;
    appTimeoutMs: number;
  };
  /** truncated is the number of utterances whose end was cut (only for runs that asked for a cut) */
  asr: { cached: number; transcribed: number; skippedOtherRate: number; truncated?: number };
  /** For the learning-from-edits experiment: utterances used for learning, and how many things were learned */
  learn?: { train: number; edited: number; words: number; forms: number; corrections: number; kept: number; numbers?: number };
  groups: Groups;
}

export interface EvalRunResult {
  dir: string;
  summary: EvalSummary;
}

interface SavedConnection {
  identity: LlmIdentity;
  maxOutputTokens: number;
  appTimeoutMs: number;
  savedAt: string;
}

function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function loadTokenizer(repoRoot: string): Promise<Tokenizer | null> {
  try {
    const wasm = path.join(repoRoot, 'node_modules/lindera-wasm-ipadic-web/lindera_wasm_bg.wasm');
    const tk = await createLinderaTokenizer(fs.readFileSync(wasm));
    tk.tokenize('準備ができました。');
    return tk;
  } catch {
    return null;
  }
}

function readReadings(file: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const [word, rs] = line.split('\t');
    if (word?.trim() && rs?.trim()) {
      out[word.trim()] = rs
        .split(/[,、]/)
        .map((r) => r.trim())
        .filter(Boolean);
    }
  }
  return out;
}

/** Applies the overrides to the settings, and picks out only the items that matter to evaluation for the record */
function effectiveSettings(config: EvalConfig, conn: LlmConnection | undefined): { settings: Settings; appTimeoutMs: number } {
  // Does not go through mergeSettings: it would treat these as old saved settings and reset items whose defaults changed (the fast path, for example)
  const merged = deepMerge(DEFAULT_SETTINGS, config.settings);
  const override = config.settings?.llm ?? {};
  const appTimeoutMs = override.timeoutMs ?? conn?.appTimeoutMs ?? DEFAULT_SETTINGS.llm.timeoutMs;
  const settings: Settings = {
    ...merged,
    llm: {
      ...merged.llm,
      maxOutputTokens: override.maxOutputTokens ?? conn?.maxOutputTokens ?? merged.llm.maxOutputTokens,
      // Evaluation has no limit on waiting, so the timeout is longer. Utterances over the app's timeout are counted separately
      timeoutMs: config.llmTimeoutMs ?? EVAL_LLM_TIMEOUT_MS,
    },
  };
  return { settings, appTimeoutMs };
}

export async function runEval(config: EvalConfig, env: EvalEnv): Promise<EvalRunResult> {
  const print = env.print ?? ((l: string) => console.log(l));
  const started = new Date();
  const root = env.root;
  const cacheDir = ensurePrivateDir(path.join(root, 'cache'));
  const runsDir = ensurePrivateDir(path.join(root, 'runs'));
  const safeName = (config.name || 'run').replace(/[^A-Za-z0-9._-]+/g, '-');
  // Keeps the folder apart from a run started with the same name in the same second
  let runName = `${localStamp(started)}-${safeName}`;
  for (let k = 2; fs.existsSync(path.join(runsDir, runName)); k++) runName = `${localStamp(started)}-${safeName}-${k}`;
  const dir = ensurePrivateDir(path.join(runsDir, runName));

  // --- LLM connection
  const connFile = path.join(cacheDir, 'llm', 'identity.json');
  let conn = env.llm;
  if (config.llm === 'live' && !conn?.provider) {
    throw new Error('Runs that call the LLM only work inside the development app (LONGHAND_EVAL). From tsx, use --llm off or --llm cache-only');
  }
  if (config.llm === 'cache-only' && !conn) {
    // Builds the key of saved results from the record of the connection the last time it was measured in the app (model and so on; no secrets)
    if (!fs.existsSync(connFile)) throw new Error(`No record of the LLM connection (${connFile}). Measure once inside the app first`);
    const saved = JSON.parse(fs.readFileSync(connFile, 'utf8')) as SavedConnection;
    conn = { provider: null, identity: saved.identity, maxOutputTokens: saved.maxOutputTokens, appTimeoutMs: saved.appTimeoutMs };
  }
  const { settings, appTimeoutMs } = effectiveSettings(config, config.llm === 'off' ? undefined : conn);
  const useLlm = config.llm !== 'off' && !settings.skipLlm && !!conn;
  const maxCalls = config.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS;
  const budget = conn?.budget ?? new CallBudget(maxCalls);
  const caching =
    useLlm && conn
      ? new CachingProvider(config.llm === 'live' ? conn.provider : null, {
          dir: ensurePrivateDir(path.join(cacheDir, 'llm')),
          identity: conn.identity,
          attempt: config.attempt ?? 0,
          budget,
          countCalls: !conn.budget,
        })
      : null;
  if (config.llm === 'live' && conn) {
    const saved: SavedConnection = { identity: conn.identity, maxOutputTokens: conn.maxOutputTokens, appTimeoutMs: conn.appTimeoutMs, savedAt: started.toISOString() };
    writePrivate(connFile, JSON.stringify(saved, null, 2));
  }

  // --- Data
  const truthFile = path.join(root, 'truth.jsonl');
  const truth = loadTruth(truthFile);
  const datasetCounts: Record<string, DatasetCounts> = {};
  const byDataset = new Map<string, Utterance[]>();
  for (const name of config.datasets) {
    const d = loadDataset(root, name, truth);
    datasetCounts[name] = d.counts;
    byDataset.set(name, d.utterances);
  }
  let utterances = [...byDataset.values()].flat();
  if (config.split && config.split !== 'all') utterances = utterances.filter((u) => u.split === config.split);
  if (config.ids?.length) {
    const ids = new Set(config.ids);
    utterances = utterances.filter((u) => ids.has(u.id));
  }
  if (config.limit) utterances = utterances.slice(0, config.limit);
  // Learning-from-edits experiment. Utterances matching train are taken out of the measured set and used for learning
  let trainUtterances: Utterance[] = [];
  if (config.learn) {
    const re = new RegExp(config.learn.train);
    trainUtterances = utterances.filter((u) => re.test(u.id));
    utterances = utterances.filter((u) => !re.test(u.id));
  }

  // --- Dictionary (the same store class as the app, on a file in the run's folder)
  const vocabTerms = config.vocab ? readWordList(config.vocab) : [];
  const store = new CustomizationsStore(path.join(dir, 'customizations.json'));
  if (vocabTerms.length) {
    store.update({ dictionary: vocabTerms, readings: config.readings ? readReadings(config.readings) : {} });
    if (caching) {
      // The app generates readings for Latin words without one with the LLM. Evaluation does the same (reusing saved results)
      store.setReadingGenerator((w) => generateReadings(w, caching, settings.llm.timeoutMs));
      while ((await store.generateReadingsNow()) > 0) {
        /* generates 50 words at a time */
      }
      store.setReadingGenerator(null);
      caching.takeLast();
    }
  }
  const withReading = store.matchEntries().filter((e) => e.readings.length).length;

  // --- Speech recognition (started only when an utterance has no saved result)
  const language = settings.language;
  const model = resolveModel(settings.asr, env.modelsDir, env.bundledModelsDir);
  const workerPath = settings.asr.workerPath || path.join(env.repoRoot, 'asr', 'build', `longhand-asr-${settings.asr.engine}`);
  const asrSig = {
    engine: settings.asr.engine,
    modelName: model?.modelPath ? path.basename(model.modelPath) : '',
    model: model?.modelPath ? fileSig(model.modelPath) : null,
    worker: fileSig(workerPath),
    options: model?.options ?? settings.asr.options,
  };
  const asrCache = new JsonCache<AsrOutcome>(ensurePrivateDir(path.join(cacheDir, 'asr')));
  let asr: AsrService | null = null;
  const getAsr = async (): Promise<Transcriber> => {
    if (config.asrCacheOnly) throw new Error('Some utterances have no saved transcription (only saved results were requested)');
    if (env.asr) return env.asr;
    if (asr) return asr;
    const svc = new AsrService(
      () => settings.asr,
      (engine) => path.join(env.repoRoot, 'asr', 'build', `longhand-asr-${engine}`),
      env.modelsDir,
      () => language,
      env.bundledModelsDir,
    );
    await svc.start();
    if (svc.status !== 'ready') throw new Error(`Could not start the ASR (${svc.status}): ${svc.message}`);
    // Waits for the warm-up to finish
    await svc.transcribe(new Float32Array(16000), { language, hints: [], timeoutMs: 60000 });
    asr = svc;
    return svc;
  };

  const tokenizer = await loadTokenizer(env.repoRoot);

  // --- Record of the run (there are no commits, so it keeps hashes of the code's contents and the build sizes)
  const src = (d: string) => path.join(env.repoRoot, 'src', 'main', d);
  const provisionalCount = utterances.filter((u) => u.provisional).length;
  // Optional settings added to transcription requests (prompt style, rehearing, alternatives). Left at their defaults, they do not change the key of saved transcriptions
  const asrExtras = {
    promptStyle: settings.asr.promptStyle,
    promptTerms: settings.asr.promptTerms,
    rehear: settings.asr.rehear,
    alternativesTopK: settings.asr.alternativesTopK,
  };
  const asrExtrasDefault = asrExtras.promptStyle === 'legacy' && !asrExtras.rehear.noHints && !asrExtras.rehear.temperatures.length && !asrExtras.alternativesTopK;
  const asrExtrasKey = asrExtrasDefault ? undefined : asrExtras;
  // How hints are used. Utterances without hints are transcribed once, so the result does not change (nor does the key of saved transcriptions)
  const hintMode = settings.asr.hintMode ?? 'always';
  const configRecord = {
    run: runName,
    name: config.name,
    startedAt: started.toISOString(),
    host: env.host,
    // Even if the settings override mixes in connection items (endpoint, headers, ...), they are not recorded. Evaluation only looks at the timeout and the output limit
    config: {
      ...config,
      vocab: config.vocab ?? null,
      settings: config.settings
        ? { ...config.settings, llm: config.settings.llm ? { timeoutMs: config.settings.llm.timeoutMs, maxOutputTokens: config.settings.llm.maxOutputTokens } : undefined }
        : undefined,
    },
    settings: {
      language: settings.language,
      skipLlm: settings.skipLlm,
      llmFastPath: settings.llmFastPath,
      textFix: settings.textFix,
      sendAppContext: settings.sendAppContext,
      sendFieldContext: settings.sendFieldContext,
      minRecordingMs: settings.minRecordingMs,
      silenceDetection: settings.silenceDetection,
      formatRules: settings.formatRules,
      formatGuard: settings.formatGuard,
      asr: { engine: settings.asr.engine, options: settings.asr.options, incremental: settings.asr.incremental, speculative: settings.asr.speculative, ...asrExtras },
      llm: { timeoutMs: settings.llm.timeoutMs, maxOutputTokens: settings.llm.maxOutputTokens },
    },
    llm: { mode: config.llm, identity: useLlm ? (conn?.identity ?? null) : null, maxCalls, appTimeoutMs, attempt: config.attempt ?? 0 },
    code: {
      format: hashTree(src('format')),
      textfix: hashTree(src('textfix')),
      vocab: hashTree(src('vocab')),
      asr: hashTree(src('asr')),
      eval: hashTree(src('eval')),
      postAsr: fs.existsSync(path.join(src('session'), 'postAsr.ts')) ? sha256Hex(fs.readFileSync(path.join(src('session'), 'postAsr.ts'))) : null,
    },
    asr: asrSig,
    tokenizer: !!tokenizer,
    vocab: { file: config.vocab ?? null, words: vocabTerms.length, withReading, sha256: vocabTerms.length ? sha256Hex(vocabTerms.join('\n')) : null },
    datasets: datasetCounts,
    truth: { file: fs.existsSync(truthFile), rows: truth.size, provisional: provisionalCount, reviewed: utterances.length - provisionalCount },
  };
  writePrivate(path.join(dir, 'config.json'), JSON.stringify(configRecord, null, 2));

  print(
    `Eval ${runName}: ${utterances.length} utterances (${config.datasets.join(', ')}), ` +
      `LLM ${config.llm}${useLlm && conn ? ` (${conn.identity.kind} ${conn.identity.model}, limit ${maxCalls} calls)` : ''}, dictionary ${vocabTerms.length} words`,
  );
  if (provisionalCount)
    print(`Note: ${provisionalCount} ${provisionalCount === 1 ? 'utterance has' : 'utterances have'} a provisional reference (not checked by a person; the compared app's output is the reference)`);
  if (!tokenizer) print('Note: could not load the tokenizer (particle correction and the reading-based error classification will not work)');

  /** Passes one utterance from transcription through formatting. Skips audio that is not 16 kHz (null) */
  const processUtterance = async (u: Utterance) => {
    // Recent transcripts (newest first in the app's history). Uses the references of earlier utterances in the same dataset.
    // Utterances without a time (public data) have no earlier utterances, so nothing is passed
    const earlier = (byDataset.get(u.dataset) ?? []).filter((x) => x.timestamp < u.timestamp || (x.timestamp === u.timestamp && x.id < u.id));
    const recent: RecentText[] =
      config.recent === 'none' || !u.timestamp
        ? []
        : earlier
            .slice(-RECENT_FOR_VOCAB)
            .reverse()
            .map((x) => ({ text: x.target, timestamp: x.timestamp }));
    const now = u.timestamp || undefined;
    const dictHints = store.asrHints({ context: {}, recent, now });
    // In place of screen words: picks name-like Latin words from the reference text of the previous utterance in the same chunk
    const screenN = config.screenTermsFromPrevious ?? 0;
    const screenTerms =
      screenN > 0
        ? extractScreenTerms(
            earlier
              .filter((x) => x.chunk === u.chunk)
              .slice(-screenN)
              .map((x) => x.target),
            { existing: store.vocabulary() },
          )
        : [];
    const seenHints = new Set(dictHints.map((h) => h.toLowerCase()));
    const hints = [...dictHints, ...screenTerms.filter((t) => !seenHints.has(t.toLowerCase()))];

    // Tail cut (experimental). Utterances that are not cut keep the key of saved transcriptions
    const cutMs = Math.max(0, config.truncateTail === 'postRoll' ? (u.postRollMs ?? 0) : (config.truncateTail ?? 0));
    const key = asrCacheKey({
      audioSha256: u.audioSha256,
      ...asrSig,
      language,
      hints,
      prompt: config.asrPrompt,
      extras: asrExtrasKey,
      // selective-2: results after disagreements that were not taken in started coming back as another hypothesis
      hintMode: hintMode === 'selective' && hints.length ? 'selective-2' : undefined,
      truncateTailMs: cutMs || undefined,
      incremental: settings.asr.incremental,
      minRecordingMs: settings.minRecordingMs,
      silenceDetection: settings.silenceDetection,
    });
    let outcome = asrCache.get(key);
    const asrCached = !!outcome;
    if (!outcome) {
      const { samples, sampleRate } = decodeWav(fs.readFileSync(u.audioPath));
      if (sampleRate !== 16000) {
        asrCount.skippedOtherRate++;
        return null;
      }
      const svc = await getAsr();
      const audio = cutMs ? samples.subarray(0, Math.max(0, samples.length - Math.round((cutMs * sampleRate) / 1000))) : samples;
      outcome = await transcribeLikeApp(svc, audio, {
        language,
        hints,
        prompt: config.asrPrompt,
        incremental: settings.asr.incremental,
        minRecordingMs: settings.minRecordingMs,
        silenceDetection: settings.silenceDetection,
        engine: settings.asr.engine,
        hintMode,
        asr: asrExtras,
      });
      asrCache.set(key, outcome);
      asrCount.transcribed++;
    } else asrCount.cached++;
    if (cutMs && asrCount.truncated !== undefined) asrCount.truncated++;

    caching?.takeLast();
    const out = await postAsrStages({
      rawText: outcome.text,
      tokens: outcome.tokens,
      uncertain: outcome.uncertain,
      settings,
      customizations: store,
      vocab: () => ({ context: {}, recent, now }),
      tokenizer,
      provider: caching,
    });
    const info = caching?.takeLast() ?? null;
    return { outcome, asrCached, cutMs, out, info };
  };

  // --- Per utterance
  const rowsFile = path.join(dir, 'rows.jsonl');
  const rows: RowRecord[] = [];
  const asrCount: EvalSummary['asr'] = { cached: 0, transcribed: 0, skippedOtherRate: 0, truncated: config.truncateTail === undefined ? undefined : 0 };
  let aborted: string | undefined;
  let learnSummary: EvalSummary['learn'];
  try {
    if (trainUtterances.length) {
      // Simulates edits that turned the output from before learning into the reference text.
      // Runs all of them first (it is output from before learning, so saved LLM results from the baseline run can be reused)
      const kinds = new Set(config.learn?.kinds ?? LEARN_KINDS);
      const outputs: { u: Utterance; raw: string; final: string }[] = [];
      for (const u of trainUtterances) {
        const done = await processUtterance(u);
        if (caching?.fatal) break;
        if (done) outputs.push({ u, raw: done.outcome.text, final: done.out.stages.final });
      }
      const counts = { train: outputs.length, edited: 0, words: 0, forms: 0, corrections: 0, kept: 0, numbers: 0 };
      // Learning time advances one second per edit, in edit order. With the real time, the order of words learned at the same time changes from run to run,
      // and the order of the speech recognition hints, and the results, waver
      let learnClock = started.getTime();
      for (const o of outputs) {
        if (caching?.fatal) break;
        // The edit target is the reference text closest to the output (chosen the same way as scoring). Alternatives differ only in notation, and either way of writing is correct.
        // Editing into the reference text itself would also learn notation differences the user would not fix (「後で」 and 「あとで」)
        const refs = [o.u.target, ...o.u.alt];
        const edited = refs[bestCer(o.final, refs, normContent).ref] ?? o.u.target;
        if (!o.final.trim() || refs.includes(o.final)) continue;
        counts.edited++;
        learnClock += 1000;
        const lr = await learnFromEdit(o.final, edited, {
          now: learnClock,
          vocabulary: store.vocabulary(),
          blocked: store.get().blockedLearnedWords,
          provider: caching,
          timeoutMs: settings.llm.timeoutMs,
          rawText: o.raw,
          tokenizer,
        });
        caching?.takeLast();
        const applied = applyLearning(
          store,
          {
            words: kinds.has('words') ? lr.words : [],
            forms: kinds.has('forms') ? lr.forms : [],
            corrections: kinds.has('corrections') ? lr.corrections : [],
            kept: kinds.has('kept') ? lr.kept : [],
            numbers: kinds.has('numbers') ? lr.numbers : [],
          },
          learnClock,
        );
        counts.words += applied.words.length;
        counts.forms += applied.forms.length;
        counts.corrections += applied.corrections.length;
        counts.kept += applied.kept.length;
        counts.numbers += applied.numbers.length;
      }
      learnSummary = counts;
      print(
        `Learning: of ${counts.train} utterances, learned from the ${counts.edited} whose output differed from the reference, as edits (words ${counts.words}, misheard forms ${counts.forms}, ` +
          `correction pairs ${counts.corrections}, kept phrases ${counts.kept}, number styles ${counts.numbers})`,
      );
      if (caching?.fatal) {
        aborted = caching.fatal.kind;
        print(`Aborted: ${redact(caching.fatal.message)}`);
      }
    }
    for (const [i, u] of utterances.entries()) {
      if (aborted) break;
      const done = await processUtterance(u);
      if (!done) continue;
      const { outcome, asrCached, cutMs, out, info } = done;
      if (caching?.fatal) {
        // Authentication or settings error, or the call limit. Stops without recording this utterance
        aborted = caching.fatal.kind;
        print(`Aborted: ${redact(caching.fatal.message)}`);
        break;
      }
      const fmt = out.llm?.fmt;
      const fix = out.noLlm?.fix;
      const byRule: Record<string, number> = {};
      for (const e of fix?.edits ?? []) byRule[e.rule] = (byRule[e.rule] ?? 0) + 1;
      const row: RowRecord = {
        id: u.id,
        dataset: u.dataset,
        split: u.split,
        chunk: u.chunk,
        durationSec: u.durationSec,
        provisional: u.provisional,
        tags: u.tags,
        category: u.category,
        target: u.target,
        spoken: u.spoken,
        alt: u.alt,
        stages: out.stages,
        ...scoreUtterance(u, out.stages, vocabTerms, tokenizer),
        asr: {
          cached: asrCached,
          segments: outcome.segments,
          skipped: outcome.skipped,
          computeMs: outcome.computeMs,
          hintsUsed: outcome.hintsUsed,
          hintsGiven: outcome.hintsGiven,
          minConfidence: out.noLlm?.minConfidence ?? null,
          uncertain: outcome.uncertain,
          truncatedMs: cutMs || undefined,
        },
        llm: {
          mode: config.llm,
          called: !!info,
          cached: info?.cached ?? false,
          fastPath: !!fmt?.fastPath,
          formatted: fmt?.formatted ?? false,
          errorKind: info?.errorKind ?? (fmt?.error ? fmt.errorKind : undefined),
          ms: info?.elapsedMs ?? 0,
          tries: info?.tries ?? 0,
          overAppTimeout: !!info && !info.errorKind && info.elapsedMs > appTimeoutMs,
          lowConfidence: out.noLlm?.lowConfidence ?? false,
          guard: fmt?.guard,
          // The LLM's output before the check. Kept to see whether the check was right, when it changed the output or a log-only check found a problem
          llmText: fmt?.guard && (fmt.guard.action !== 'none' || fmt.guard.violations.length || fmt.guard.counts.unsupported) ? fmt.llmText : undefined,
        },
        match: { replaced: out.noLlm?.prep?.replaced ?? 0, candidates: out.llm?.prep?.candidates.length ?? 0 },
        textfix: { edits: fix?.edits.length ?? 0, byRule, candidates: fix?.candidates.length ?? 0 },
      };
      rows.push(row);
      appendPrivate(rowsFile, `${JSON.stringify(row)}\n`);
      const llmNote = !useLlm
        ? ''
        : row.llm.fastPath
          ? ' fast path'
          : row.llm.called
            ? row.llm.errorKind
              ? ` LLM failed (${row.llm.errorKind})`
              : row.llm.cached
                ? ' LLM cached'
                : ` LLM ${row.llm.ms}ms`
            : '';
      print(
        `[${String(i + 1).padStart(3)}/${utterances.length}] ${u.dataset} ${u.split.padEnd(7)} ${u.durationSec.toFixed(1).padStart(5)}s ` +
          `ASR ${asrCached ? 'cached' : `${outcome.computeMs}ms`}${llmNote}`,
      );
    }
  } finally {
    (asr as AsrService | null)?.stop();
    store.flush();
  }

  // --- Totals
  const finished = new Date();
  const summary: EvalSummary = {
    run: runName,
    name: config.name,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    status: aborted ? 'aborted' : 'ok',
    aborted,
    provisional: rows.some((r) => r.provisional),
    truth: { provisional: rows.filter((r) => r.provisional).length, reviewed: rows.filter((r) => !r.provisional).length },
    llm: {
      mode: config.llm,
      kind: useLlm ? conn?.identity.kind : undefined,
      model: useLlm ? conn?.identity.model : undefined,
      calls: caching?.stats.calls ?? 0,
      httpRequests: conn?.budget ? conn.budget.used : undefined,
      maxCalls,
      cacheHits: caching?.stats.hits ?? 0,
      cacheMisses: caching?.stats.misses ?? 0,
      stored: caching?.stats.stored ?? 0,
      failures: caching?.stats.failures ?? 0,
      timeoutMs: settings.llm.timeoutMs,
      appTimeoutMs,
    },
    asr: asrCount,
    learn: learnSummary,
    groups: summarize(rows),
  };
  writePrivate(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  const all = summary.groups.all;
  appendPrivate(
    path.join(runsDir, 'index.jsonl'),
    `${JSON.stringify({
      run: runName,
      name: config.name,
      startedAt: summary.startedAt,
      finishedAt: summary.finishedAt,
      status: summary.status,
      datasets: config.datasets,
      n: all.n,
      provisional: summary.truth.provisional,
      llmMode: config.llm,
      llmCalls: summary.llm.calls,
      vocabWords: vocabTerms.length,
      asrCer: all.stages.asr.contentCer,
      noLlmCer: all.stages.noLlm.contentCer,
      finalCer: config.llm === 'off' ? null : all.stages.final.contentCer,
      finalFullCer: config.llm === 'off' ? null : all.stages.final.fullCer,
      finalExact: config.llm === 'off' ? null : all.stages.final.exact,
    })}\n`,
  );

  // --- Display (numbers only)
  print('');
  print(`=== Summary${summary.provisional ? ' (provisional baseline; includes utterances with a provisional reference)' : ''}${aborted ? ` (stopped early: ${aborted})` : ''} ===`);
  for (const l of formatGroup('All', all, config.llm)) print(l);
  for (const [name, g] of Object.entries(summary.groups.byDataset)) for (const l of formatGroup(name, g, config.llm)) print(l);
  for (const [name, g] of Object.entries(summary.groups.bySplit)) for (const l of formatGroup(name === 'dev' ? 'Dev set' : 'Holdout set', g, config.llm)) print(l);
  if (summary.groups.byCategory) for (const l of formatCategories(summary.groups.byCategory, config.llm)) print(l);
  print('');
  for (const l of formatDetail(all, config.llm, vocabTerms.length)) print(l);
  if (caching) {
    const http = summary.llm.httpRequests !== undefined ? `, HTTP requests ${summary.llm.httpRequests}` : '';
    print(`LLM calls        ${summary.llm.calls}${http} (limit ${maxCalls}), from saved results ${summary.llm.cacheHits}, newly saved ${summary.llm.stored}`);
  }
  print(`Speech recognition saved ${asrCount.cached}, transcribed now ${asrCount.transcribed}${asrCount.skippedOtherRate ? `, skipped (not 16 kHz) ${asrCount.skippedOtherRate}` : ''}`);
  if (asrCount.truncated !== undefined) {
    print(`Tail cut         utterances ${asrCount.truncated} (${config.truncateTail === 'postRoll' ? 'per-row length recorded after release' : `${config.truncateTail} ms`})`);
  }
  print(`Results: ${dir}`);
  return { dir, summary };
}
