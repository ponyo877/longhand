/**
 * 評価の実行の本体。データセットの発話を、アプリと同じ手順（pipeline.ts）で通し、段階ごとに正解と比べる。
 *
 * electron は読み込まない。tsx（scripts/eval-run.ts）からも、開発版のアプリの中（LONGHAND_EVAL）からも呼べる。
 * LLM を実際に呼べるのはアプリの中だけ（保存済みの接続設定とキーを使うため）。tsx からは、LLM なしか、保存済みの結果だけで動かす。
 *
 * 結果: <root>/runs/<日時>-<名前>/{config.json, rows.jsonl, summary.json} と <root>/runs/index.jsonl
 * - rows.jsonl は発話ごとの文を含む（個人の書き起こし）。summary.json と標準出力は数だけ
 * - API キー、ヘッダ、接続先は、どのファイルにも書かない
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

/** 辞書の語の得点に使う、最近の書き起こしの件数（アプリの RECENT_FOR_VOCAB と同じ） */
const RECENT_FOR_VOCAB = 100;
/** 評価での LLM の時間切れ。アプリの時間切れ（既定 8 秒）を超えた件数は別に数える */
const EVAL_LLM_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_LLM_CALLS = 150;

/** 手直しから覚えることの種類（語、聞き違えた形、取り違えの組、書き換えない語句） */
export type LearnKind = 'words' | 'forms' | 'corrections' | 'kept';
const LEARN_KINDS: readonly LearnKind[] = ['words', 'forms', 'corrections', 'kept'];

export interface EvalConfig {
  /** 実行の名前（結果のフォルダ名に入る） */
  name: string;
  /** 測るデータセットの名前（<root>/datasets/<名前>） */
  datasets: string[];
  /** アプリの既定（DEFAULT_SETTINGS）への上書き */
  settings?: DeepPartial<Settings>;
  /** 辞書の語の一覧のファイル（1 行 1 語）。無ければ辞書なし */
  vocab?: string | null;
  /** 読みのファイル（1 行に「語<TAB>読み,読み」）。利用者が確かめた読みとして扱う */
  readings?: string | null;
  /** off: LLM なし。live: LLM を呼ぶ（アプリの中だけ）。cache-only: 保存済みの結果だけを使う */
  llm: LlmMode;
  /** 1 回の実行で LLM を呼んでよい回数（既定 150） */
  maxLlmCalls?: number;
  /** 評価での LLM の時間切れ（既定 60 秒） */
  llmTimeoutMs?: number;
  /** 試行番号。同じ入力でも LLM を呼び直したいときに変える */
  attempt?: number;
  /** 発話を絞る */
  split?: Split | 'all';
  ids?: string[];
  limit?: number;
  /** 辞書の語の得点に使う「最近の書き起こし」。previous は同じデータセットの前の発話の正解、none は無し（既定は previous） */
  recent?: 'previous' | 'none';
  /**
   * 整形のモデルと設定の差し替え（モデルの比較用）。接続先とキーは、アプリに保存済みのものをそのまま使う。
   * 差し替えた内容は、保存済みの LLM の結果のキーに入るので、モデルごとに別の結果として保存される
   */
  llmOverride?: { model?: string; anthropic?: { effort?: string; thinking?: string } };
  /**
   * 画面の文から拾った語を、その発話のヒントに足す実験（アプリの asr.screenTerms の代わり）。
   * 評価のデータには入力先の画面の文が無いので、同じ塊（3 分以内に続く発話）の、直前の発話の正解の文を「画面に出ている文」とみなす。
   * チャットやターミナルでは、直前に入力した文が画面に残っているためである。数は、何件前までを見るか（0 か未指定なら足さない）。
   * 正解の文を使うので、実際より良い側に出る（上限の目安）
   */
  screenTermsFromPrevious?: number;
  /**
   * 手直しからの学習の効果を測る実験。train（発話の id の正規表現）に当たる発話を、測る対象から外して先に流し、
   * その出力を正解の文に直した、という手直しを模して学習させる（アプリと同じ learnFromEdit を通す）。
   * 残りの発話は、学習した内容を持った状態で測る。kinds で、覚える種類を絞れる（既定はすべて）
   */
  learn?: { train: string; kinds?: LearnKind[] };
  /** 音声認識を動かさず、保存済みの結果だけを使う */
  asrCacheOnly?: boolean;
  /** 丸ごと書き起こすときに渡す prompt（実験用。アプリは渡さない） */
  asrPrompt?: string;
  /**
   * 書き起こす前に、音声の末尾を切り落とす（実験用）。同じ録音で「キーを離した後の録音あり」と「なし」を比べるためのもの。
   * 'postRoll' は、行の postRollMs（離した後に録った長さ）の分だけ切り落とす。無い行はそのまま。数値は、どの行もその長さ（ms）だけ切り落とす
   */
  truncateTail?: 'postRoll' | number;
}

/** LLM の接続（アプリの中で、保存済みの設定とキーから作る） */
export interface LlmConnection {
  /** 実際の LLM。保存済みの結果だけを使うなら null */
  provider: LlmProvider | null;
  identity: LlmIdentity;
  /** 設定の出力の上限と、アプリの時間切れ */
  maxOutputTokens: number;
  appTimeoutMs: number;
  /** 通信の入口（fetch）で呼び出しを数えているなら、その数え役。渡さなければ CachingProvider が数える */
  budget?: CallBudget;
}

export interface EvalEnv {
  /** 評価のデータの置き場所（~/longhand-eval） */
  root: string;
  /** リポジトリ（ワーカー、単語分割の WASM、コードのハッシュ） */
  repoRoot: string;
  /** 音声認識のモデルのフォルダ */
  modelsDir: string;
  bundledModelsDir?: string;
  llm?: LlmConnection;
  /** 書き起こしの差し替え（テスト用）。渡さなければ、ASR ワーカーを起動する */
  asr?: Transcriber;
  /** 動かしている場所（記録用） */
  host: string;
  print?: (line: string) => void;
}

export interface EvalSummary {
  run: string;
  name: string;
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'aborted';
  /** 途中で止めた理由（種類だけ） */
  aborted?: string;
  /** 正解が仮の発話を含むか。含むなら、数値は仮の基準値として読む */
  provisional: boolean;
  truth: { provisional: number; reviewed: number };
  llm: {
    mode: LlmMode;
    kind?: string;
    model?: string;
    /** LLM を実際に呼んだ回数（やり直しを含む） */
    calls: number;
    /** 送った HTTP リクエストの数（通信の入口で数えたときだけ） */
    httpRequests?: number;
    maxCalls: number;
    cacheHits: number;
    cacheMisses: number;
    stored: number;
    failures: number;
    timeoutMs: number;
    appTimeoutMs: number;
  };
  /** truncated は、末尾を切り落とした発話の数（切り落としを指定した実行だけ） */
  asr: { cached: number; transcribed: number; skippedOtherRate: number; truncated?: number };
  /** 手直しからの学習の実験をしたときの、学習に使った発話の数と、覚えた数 */
  learn?: { train: number; edited: number; words: number; forms: number; corrections: number; kept: number };
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

/** 設定に上書きを重ね、評価に関わる項目だけを記録用に取り出す */
function effectiveSettings(config: EvalConfig, conn: LlmConnection | undefined): { settings: Settings; appTimeoutMs: number } {
  // mergeSettings は通さない。保存済みの古い設定とみなされて、既定値を変えた項目（近道など）が既定に戻されるため
  const merged = deepMerge(DEFAULT_SETTINGS, config.settings);
  const override = config.settings?.llm ?? {};
  const appTimeoutMs = override.timeoutMs ?? conn?.appTimeoutMs ?? DEFAULT_SETTINGS.llm.timeoutMs;
  const settings: Settings = {
    ...merged,
    llm: {
      ...merged.llm,
      maxOutputTokens: override.maxOutputTokens ?? conn?.maxOutputTokens ?? merged.llm.maxOutputTokens,
      // 評価では待ち時間の制限がないので、時間切れを長くする。アプリの時間切れを超えた件数は別に数える
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
  // 同じ秒に同じ名前で始めた実行と、フォルダが重ならないようにする
  let runName = `${localStamp(started)}-${safeName}`;
  for (let k = 2; fs.existsSync(path.join(runsDir, runName)); k++) runName = `${localStamp(started)}-${safeName}-${k}`;
  const dir = ensurePrivateDir(path.join(runsDir, runName));

  // --- LLM の接続
  const connFile = path.join(cacheDir, 'llm', 'identity.json');
  let conn = env.llm;
  if (config.llm === 'live' && !conn?.provider) {
    throw new Error('LLM を呼ぶ実行は、開発版のアプリの中（LONGHAND_EVAL）でだけ動かせます。tsx からは --llm off か --llm cache-only を使ってください');
  }
  if (config.llm === 'cache-only' && !conn) {
    // アプリの中で最後に測ったときの接続の記録（モデルなど。秘密は含まない）から、保存済みの結果のキーを作る
    if (!fs.existsSync(connFile)) throw new Error(`LLM の接続の記録がありません（${connFile}）。先にアプリの中で 1 回測ってください`);
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

  // --- データ
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
  // 手直しからの学習の実験。train に当たる発話は、測る対象から外して、学習に使う
  let trainUtterances: Utterance[] = [];
  if (config.learn) {
    const re = new RegExp(config.learn.train);
    trainUtterances = utterances.filter((u) => re.test(u.id));
    utterances = utterances.filter((u) => !re.test(u.id));
  }

  // --- 辞書（アプリと同じ保存先のクラスを、実行のフォルダに置いたファイルで動かす）
  const vocabTerms = config.vocab ? readWordList(config.vocab) : [];
  const store = new CustomizationsStore(path.join(dir, 'customizations.json'));
  if (vocabTerms.length) {
    store.update({ dictionary: vocabTerms, readings: config.readings ? readReadings(config.readings) : {} });
    if (caching) {
      // アプリは、読みのない英字の語の読みを LLM で作っておく。評価でも同じように作る（保存済みの結果を使い回す）
      store.setReadingGenerator((w) => generateReadings(w, caching, settings.llm.timeoutMs));
      while ((await store.generateReadingsNow()) > 0) {
        /* 50 語ずつ作る */
      }
      store.setReadingGenerator(null);
      caching.takeLast();
    }
  }
  const withReading = store.matchEntries().filter((e) => e.readings.length).length;

  // --- 音声認識（保存済みの結果が無い発話が出たときにだけ起動する）
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
    if (config.asrCacheOnly) throw new Error('書き起こしの保存済みの結果が無い発話があります（保存済みの結果だけを使う指定）');
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
    if (svc.status !== 'ready') throw new Error(`ASR を起動できませんでした（${svc.status}）: ${svc.message}`);
    // ウォームアップの完了を待つ
    await svc.transcribe(new Float32Array(16000), { language, hints: [], timeoutMs: 60000 });
    asr = svc;
    return svc;
  };

  const tokenizer = await loadTokenizer(env.repoRoot);

  // --- 実行の記録（コミットが無いので、コードの中身のハッシュとビルドの大きさを残す）
  const src = (d: string) => path.join(env.repoRoot, 'src', 'main', d);
  const provisionalCount = utterances.filter((u) => u.provisional).length;
  // 書き起こしの要求に付ける任意の指定（プロンプトの様式、聞き直し、別候補）。既定のままなら、保存済みの書き起こしのキーを変えない
  const asrExtras = {
    promptStyle: settings.asr.promptStyle,
    promptTerms: settings.asr.promptTerms,
    rehear: settings.asr.rehear,
    alternativesTopK: settings.asr.alternativesTopK,
  };
  const asrExtrasDefault = asrExtras.promptStyle === 'legacy' && !asrExtras.rehear.noHints && !asrExtras.rehear.temperatures.length && !asrExtras.alternativesTopK;
  const asrExtrasKey = asrExtrasDefault ? undefined : asrExtras;
  // ヒントの使い方。ヒントが無い発話は 1 回だけ書き起こすので、結果は変わらない（保存済みの書き起こしのキーも変えない）
  const hintMode = settings.asr.hintMode ?? 'always';
  const configRecord = {
    run: runName,
    name: config.name,
    startedAt: started.toISOString(),
    host: env.host,
    // 設定の上書きに接続の項目（接続先、ヘッダなど）が混ざっていても、記録には残さない。評価が見るのは時間切れと出力の上限だけ
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
    `評価 ${runName}: ${utterances.length} 件（${config.datasets.join('、')}）、LLM ${config.llm}${useLlm && conn ? `（${conn.identity.kind} ${conn.identity.model}、上限 ${maxCalls} 回）` : ''}、辞書 ${vocabTerms.length} 語`,
  );
  if (provisionalCount) print(`注意: 正解が仮の発話が ${provisionalCount} 件あります（人が確かめていない。比較対象のアプリの出力を正解とみなした値）`);
  if (!tokenizer) print('注意: 単語分割を読み込めませんでした（助詞の補正と、読みによる誤りの分類が動きません）');

  /** 1 件の発話を、書き起こしから整形まで通す。16 kHz でない音声は飛ばす（null） */
  const processUtterance = async (u: Utterance) => {
    // 最近の書き起こし（アプリでは履歴の新しい順）。同じデータセットの、この発話より前の発話の正解を使う。
    // 時刻の無い発話（公開データ）には、前の発話というものが無いので渡さない
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
    // 画面の語の代わり: 同じ塊の、直前の発話の正解の文から、名前らしい英字の語を拾う
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

    // 末尾の切り落とし（実験用）。切り落とさない発話では、保存済みの書き起こしのキーを変えない
    const cutMs = Math.max(0, config.truncateTail === 'postRoll' ? (u.postRollMs ?? 0) : (config.truncateTail ?? 0));
    const key = asrCacheKey({
      audioSha256: u.audioSha256,
      ...asrSig,
      language,
      hints,
      prompt: config.asrPrompt,
      extras: asrExtrasKey,
      // selective-2: 取り込まなかった食い違いを、別の仮説として返すようになった後の結果
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

  // --- 発話ごと
  const rowsFile = path.join(dir, 'rows.jsonl');
  const rows: RowRecord[] = [];
  const asrCount: EvalSummary['asr'] = { cached: 0, transcribed: 0, skippedOtherRate: 0, truncated: config.truncateTail === undefined ? undefined : 0 };
  let aborted: string | undefined;
  let learnSummary: EvalSummary['learn'];
  try {
    if (trainUtterances.length) {
      // 学習の前の状態で流した出力を、正解の文に直した、という手直しを模す。
      // 先に全部を流しておく（学習の前の出力なので、基準の実行で保存済みの LLM の結果をそのまま使える）
      const kinds = new Set(config.learn?.kinds ?? LEARN_KINDS);
      const outputs: { u: Utterance; raw: string; final: string }[] = [];
      for (const u of trainUtterances) {
        const done = await processUtterance(u);
        if (caching?.fatal) break;
        if (done) outputs.push({ u, raw: done.outcome.text, final: done.out.stages.final });
      }
      const counts = { train: outputs.length, edited: 0, words: 0, forms: 0, corrections: 0, kept: 0 };
      // 学習した時刻は、手直しの順に 1 秒ずつ進める。実際の時刻を使うと、同じ時刻に学習した語の並びが実行のたびに変わり、
      // 音声認識のヒントの順と、結果がゆらぐ
      let learnClock = started.getTime();
      for (const o of outputs) {
        if (caching?.fatal) break;
        // 直す先は、出力に最も近い正解の文にする（採点と同じ選び方）。別解は、表記だけが違う書き方で、どちらで書いても誤りではない。
        // 正解の文そのものに直すことにすると、利用者が直さないはずの表記の違い（「後で」と「あとで」）まで学習してしまう
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
          },
          learnClock,
        );
        counts.words += applied.words.length;
        counts.forms += applied.forms.length;
        counts.corrections += applied.corrections.length;
        counts.kept += applied.kept.length;
      }
      learnSummary = counts;
      print(
        `学習: ${counts.train} 件のうち、出力が正解と違った ${counts.edited} 件を手直しとして学習（語 ${counts.words}、聞き違えた形 ${counts.forms}、` +
          `取り違えの組 ${counts.corrections}、書き換えない語句 ${counts.kept}）`,
      );
      if (caching?.fatal) {
        aborted = caching.fatal.kind;
        print(`中止: ${redact(caching.fatal.message)}`);
      }
    }
    for (const [i, u] of utterances.entries()) {
      if (aborted) break;
      const done = await processUtterance(u);
      if (!done) continue;
      const { outcome, asrCached, cutMs, out, info } = done;
      if (caching?.fatal) {
        // 認証や設定の誤り、呼び出しの上限。この発話は記録せずに止める
        aborted = caching.fatal.kind;
        print(`中止: ${redact(caching.fatal.message)}`);
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
          // 検査の前の LLM の出力。検査が出力を変えたか、記録だけの検査で問題を見つけたときに、当たり外れを調べるために残す
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
          ? ' 近道'
          : row.llm.called
            ? row.llm.errorKind
              ? ` LLM 失敗（${row.llm.errorKind}）`
              : row.llm.cached
                ? ' LLM 保存済み'
                : ` LLM ${row.llm.ms}ms`
            : '';
      print(
        `[${String(i + 1).padStart(3)}/${utterances.length}] ${u.dataset} ${u.split.padEnd(7)} ${u.durationSec.toFixed(1).padStart(5)}s ASR ${asrCached ? '保存済み' : `${outcome.computeMs}ms`}${llmNote}`,
      );
    }
  } finally {
    (asr as AsrService | null)?.stop();
    store.flush();
  }

  // --- 集計
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

  // --- 表示（数だけ）
  print('');
  print(`=== 集計${summary.provisional ? '（仮の基準値。正解が仮の発話を含む）' : ''}${aborted ? `（途中で止めた: ${aborted}）` : ''} ===`);
  for (const l of formatGroup('全体', all, config.llm)) print(l);
  for (const [name, g] of Object.entries(summary.groups.byDataset)) for (const l of formatGroup(name, g, config.llm)) print(l);
  for (const [name, g] of Object.entries(summary.groups.bySplit)) for (const l of formatGroup(name === 'dev' ? '開発用' : '確認用', g, config.llm)) print(l);
  if (summary.groups.byCategory) for (const l of formatCategories(summary.groups.byCategory, config.llm)) print(l);
  print('');
  for (const l of formatDetail(all, config.llm, vocabTerms.length)) print(l);
  if (caching) {
    const http = summary.llm.httpRequests !== undefined ? `、HTTP リクエスト ${summary.llm.httpRequests} 回` : '';
    print(`LLM の呼び出し  ${summary.llm.calls} 回${http}（上限 ${maxCalls} 回）、保存済みを使った ${summary.llm.cacheHits} 回、新しく保存 ${summary.llm.stored} 回`);
  }
  print(`音声認識        保存済み ${asrCount.cached} 件、今回書き起こした ${asrCount.transcribed} 件${asrCount.skippedOtherRate ? `、16 kHz 以外で飛ばした ${asrCount.skippedOtherRate} 件` : ''}`);
  if (asrCount.truncated !== undefined) {
    print(`末尾の切り落とし ${asrCount.truncated} 件（${config.truncateTail === 'postRoll' ? '行ごとの、離した後に録った長さ' : `${config.truncateTail} ms`}）`);
  }
  print(`結果: ${dir}`);
  return { dir, summary };
}
