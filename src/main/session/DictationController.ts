import { randomUUID } from 'node:crypto';
import type { AsrResultPayload } from '../../shared/asr-protocol';
import type { AudioChunkPayload, AudioDevice, AudioErrorPayload, ContextPayload, FieldWatchResultPayload, HelperToMain, PasteAckPayload, PttState } from '../../shared/protocol';
import type { FloaterState, HistoryItem, HistoryTimings, SoundName } from '../../shared/types';
import { isAsrCancelled, type AsrService, type TranscribeOptions } from '../asr/AsrService';
import { isNoSpeechByLevel, Segmenter, WHOLE_MAX_SEC } from '../asr/Segmenter';
import { joinTexts } from '../format/postprocess';
import type { HelperClient } from '../helper/HelperClient';
import { applyLearning } from '../learn/apply';
import { learnFromWatchDetailed } from '../learn/Learner';
import type { LlmProvider } from '../llm/types';
import { createLogger } from '../log';
import { composePaste, escapeTokens } from '../paste/PasteComposer';
import type { CustomizationsStore } from '../store/customizations';
import type { HistoryStore } from '../store/history';
import type { RecordingStore } from '../store/recordings';
import type { SettingsStore } from '../store/settings';
import type { NotificationKey } from '../ui/notifications';
import type { Tokenizer } from '../textfix';
import { charConfidence, type Confidence } from '../textfix/align';
import type { Uncertain } from '../asr/hypotheses';
import { asrRequestExtras, uncertainOf } from '../asr/requestOptions';
import { transcribeSelective } from '../asr/selectiveHints';
import { extractScreenTerms } from '../vocab/screenTerms';
import type { HintContext, RecentText } from '../vocab/hints';
import { HotkeyInterpreter, type Command } from './HotkeyInterpreter';
import { postAsr, TERMINAL_BUNDLES } from './postAsr';

const log = createLogger('session');

const SR = 16000;
/** 停止から結果を貼るまでの期限。これを過ぎた結果は履歴だけに残す */
const STALE_MS = 120_000;
/** 届いている音声の末尾がこれだけ無音なら、離した後の残りの音声を待たずに進む（先回りの書き起こしを始める無音の長さと同じ） */
const TAIL_SKIP_QUIET_SEC = 0.3;
/** 届いている音声の末尾がこれ以上無音なら、キーを離した後の録音（asr.tailMs）を続けない（話し終えている） */
const POST_ROLL_SKIP_QUIET_SEC = 1.0;
/** 編集モードで扱う選択範囲の上限 */
const EDIT_MAX_CHARS = 6000;
/** 取り消した録音でも、これより長ければ履歴と音声を残す（誤って取り消したときに戻れるように） */
const KEEP_CANCELLED_SAMPLES = 2 * SR;
/** 投機的な書き起こしをやり直すのは、前回の範囲から音声がこれだけ増えたときだけ（GPU の負荷を抑える） */
const SPEC_MIN_NEW_SAMPLES = 1 * SR;
/** 最初の音声が届かなくても、開始音はこの時間で鳴らす */
const START_SOUND_FALLBACK_MS = 600;
/** 録音開始からこの長さの間、ピークがずっと小さければ「マイクから音が届いていない」と知らせる */
const NO_SIGNAL_CHECK_SAMPLES = 2.5 * SR;
const NO_SIGNAL_PEAK = 0.0005;
/** 確定するときに ASR が準備中なら、ここまで待つ */
const ASR_READY_WAIT_MS = 10_000;
/** 前の録音の結果を貼る前に、新しい録音の文脈（貼り付け先のアプリ）が届くのを待つ時間 */
const NEWER_CONTEXT_WAIT_MS = 300;
/** ロックせずにこれだけ押し続けたら、ロックのやり方を案内する */
const HOLD_LONG_HINT_SAMPLES = 40 * SR;
/** 語彙ヒントと辞書の照合の得点に使う、最近の書き起こしの件数 */
const RECENT_FOR_VOCAB = 100;
/**
 * 貼り付けの着地確認をしないアプリ（PST-3）。ターミナルは画面の文字全体が値なので出力が流れると着地と誤認し、
 * リモートデスクトップと仮想マシンは手元から欄が読めないので、確かめても誤報になる
 */
const NO_LANDING_CHECK_BUNDLES = new Set([
  ...TERMINAL_BUNDLES,
  'com.microsoft.rdc.macos',
  'com.microsoft.rdc.mac',
  'com.citrix.receiver.icaviewer.mac',
  'com.citrix.receiver.nomas',
  'com.vmware.horizon',
  'com.vmware.fusion',
  'com.parallels.desktop.console',
  'com.utmapp.UTM',
  'com.apple.ScreenSharing',
  'com.teamviewer.TeamViewer',
  'com.realvnc.vncviewer',
  'com.p5sys.jump.mac.viewer',
  'tv.parsec.www',
  'com.philandro.anydesk',
  'org.virtualbox.app.VirtualBoxVM',
  'com.lemonmojo.RoyalTSX.App',
]);

export interface UiPort {
  floater(state: Partial<FloaterState>): void;
  level(rms: number): void;
  hud(key: NotificationKey, vars?: Record<string, string>, actions?: { id: string; label: string; run: () => void }[]): void;
  sound(name: SoundName): void;
  /** LLM の接続先へ事前に接続しておく（TLS の握手を録音中に済ませる） */
  preconnect(): void;
}

export interface ControllerDeps {
  helper: HelperClient;
  asr: AsrService;
  settings: SettingsStore;
  customizations: CustomizationsStore;
  history: HistoryStore;
  recordings: RecordingStore;
  ui: UiPort;
  /** 設定から LlmProvider を作る。未設定や skipLlm なら null */
  provider: () => LlmProvider | null;
  /** textfix の単語分割。読み込み中か使えなければ null（単語分割を使う規則だけを飛ばす） */
  tokenizer?: () => Tokenizer | null;
}

interface Segment {
  start: number;
  end: number;
  text: Promise<string>;
}

/** 話の間で先に書き起こした結果（投機的な書き起こし） */
interface Speculation {
  /** 書き起こした範囲の終わり（サンプル）。範囲は録音の先頭から */
  end: number;
  abort: AbortController;
  promise: Promise<AsrResultPayload>;
  /** 後から何か話したので、この結果は使えない */
  invalid: boolean;
}

/** 区間の計測に使う時刻（ms エポック） */
interface Marks {
  stopped?: number;
  asrDone?: number;
  llmDone?: number;
  pasteSent?: number;
  keyPosted?: number;
  ack?: number;
  pasteWaitMs?: number;
  /** ヘルパーが貼り付け前の AX の読み取りにかけた時間（ms） */
  preReadMs?: number;
}

interface Session {
  lease: number;
  startedAt: number;
  ptt: 'active' | 'locked' | 'finalizing';
  mode: 'dictation' | 'edit';
  context: ContextPayload | null;
  contextPromise: Promise<ContextPayload | null>;
  segmenter: Segmenter;
  segments: Segment[];
  /** 書き起こさずに飛ばした区切りがあるか（あれば最後に全体を書き起こす） */
  segmentSkipped: boolean;
  audio: 'starting' | 'running' | 'failed' | 'stopped';
  device?: { name: string; transport: string };
  abort: AbortController;
  cancelled: boolean;
  stoppedAt?: number;
  /** 確定処理が終わったら解決する（貼り付けを録音の順に並べるのに使う） */
  done: Promise<void>;
  resolveDone: () => void;
  /** 履歴に残したか */
  finished: boolean;
  /** 書き起こしの結果（取り消したときに履歴へ残すため） */
  rawText?: string;
  spec?: Speculation;
  specResult?: 'hit' | 'miss';
  /** 最初の音声チャンクが届いた時刻 */
  firstChunkAt?: number;
  /** まだ鳴らしていない開始音 */
  pendingSound: SoundName | null;
  startSoundTimer?: NodeJS.Timeout;
  /** 録音開始からの最大振幅（マイクから音が届いているかの判定用） */
  peak: number;
  noSignalChecked: boolean;
  /** ヘルパーのイベント時刻と main の時計の差の最小値（キーを離してから届くまでの時間の推定に使う） */
  clockOffset?: number;
  releaseLagMs?: number;
  /** キーを離した後も録音を続けた時間（続けたときだけ） */
  postRollMs?: number;
  /** 音声認識が聞き違えたかもしれない箇所（丸ごと書き起こしたときだけ） */
  uncertain?: Uncertain[];
  marks: Marks;
  /** 利用者の操作でなく取り消した（エラーなど）。取り消しの通知を出さない */
  cancelSilent?: boolean;
  /** ロックの案内を出したか */
  holdHintShown?: boolean;
  /** ASR に渡した語彙ヒントのうち、プロンプトに入った数と渡した数（ワーカーが報告したとき） */
  hints?: { used?: number; given: number };
  /** 書き起こし（rawText）の文字ごとの確信度。丸ごと書き起こしたときだけ（区切って書き起こした長い録音では null） */
  confidence?: Confidence | null;
  /** 中身の字の確信度の最小値（ログに出して、LLM に回す基準を見直すときの手がかりにする） */
  minConfidence?: number | null;
}

function decodePcm(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  // Buffer のプールのずれを避けるため、新しい ArrayBuffer にコピーする
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}

const delay = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), ms));
const nonEmpty = <T>(list: T[]): T[] | undefined => (list.length ? list : undefined);

/**
 * 音声入力の 1 回分を最初から最後まで受け持つ（セッションの状態機械）。
 *
 * リース ID は録音のたびに増える。ASR、LLM、貼り付けの結果は開始時のリース ID を持ち回る。
 * 前の録音の確定中に次の録音を始めたら、貼り付けは録音の順に行う（前の結果を先に貼る）。
 * 次の録音が別のアプリ向けか編集モードなら、前の結果は貼らずに履歴だけに残す。
 */
export class DictationController {
  private lease = 0;
  /** 録音中のセッション（1 つだけ） */
  private recording: Session | null = null;
  /** 確定処理中のセッション */
  private finalizing = new Set<Session>();
  private readonly interpreter: HotkeyInterpreter;
  private devices: AudioDevice[] = [];
  /** 貼り付けの後の手直しを待っている貼り付け。rawText は整形の前の書き起こし（整形の書き換えを戻した手直しを見分けるのに使う） */
  private pendingWatches = new Map<string, { inserted: string; rawText: string }>();
  private shownHandsFreeInfo = false;
  private shownBluetoothInfo = false;
  /** 処理中のホットキーのイベント（ヘルパーの時刻 t と、main が受け取った時刻） */
  private currentHotkey: { t: number; at: number } | null = null;

  constructor(private readonly d: ControllerDeps) {
    this.interpreter = new HotkeyInterpreter(
      () => ({ recording: !!this.recording, locked: this.recording?.ptt === 'locked', finalizing: this.finalizing.size > 0 }),
      (cmd) => this.exec(cmd),
      { doubleTapMs: () => d.settings.get().doubleTapMs, doubleTapToLock: () => d.settings.get().doubleTapToLock },
    );
    d.helper.on('message', (m: HelperToMain) => this.onHelperMessage(m));
    d.helper.on('exit', () => this.onHelperExit());
  }

  /** 録音中にヘルパーが落ちたら、離す操作はもう届かないので、ここで録音を閉じる */
  private onHelperExit(): void {
    const r = this.recording;
    if (!r) return;
    log.warn('録音中にヘルパーが終了しました');
    r.audio = 'failed';
    if (r.segmenter.length > SR) {
      this.d.ui.hud('HelperCrashed');
      void this.stop();
    } else {
      this.cancel(true);
    }
  }

  // -------------------------------------------------------------------------
  // 入力
  // -------------------------------------------------------------------------

  private onHelperMessage(m: HelperToMain): void {
    switch (m.type) {
      case 'hotkey': {
        const hk = { t: m.payload.t, at: Date.now() };
        const r = this.recording;
        if (r) r.clockOffset = Math.min(r.clockOffset ?? Infinity, hk.at - hk.t);
        this.currentHotkey = hk;
        try {
          this.interpreter.handle(m.payload);
        } finally {
          this.currentHotkey = null;
        }
        break;
      }
      case 'audio_chunk':
        this.onChunk(m.payload);
        break;
      case 'audio_error':
        this.onAudioError(m.payload);
        break;
      case 'audio_devices_changed':
        this.onDevicesChanged(m.payload.devices);
        break;
      case 'field_watch_result':
        void this.onFieldWatch(m.payload);
        break;
    }
  }

  /** フローティングバーのボタンやトレイからの操作 */
  uiAction(action: 'start' | 'finish' | 'cancel' | 'toggle'): void {
    if (action === 'start') {
      if (!this.recording) this.exec({ kind: 'start', locked: true });
    } else if (action === 'finish') {
      if (this.recording) this.exec({ kind: 'stop' });
    } else if (action === 'cancel') {
      if (this.recording || this.finalizing.size) this.exec({ kind: 'cancel', silent: false });
    } else if (action === 'toggle') {
      if (this.recording) this.exec({ kind: 'stop' });
      else this.exec({ kind: 'start', locked: true });
    }
  }

  private exec(cmd: Command): void {
    switch (cmd.kind) {
      case 'start':
        this.start(cmd.locked);
        break;
      case 'lock':
        this.lock();
        break;
      case 'stop':
        void this.stop();
        break;
      case 'cancel':
        this.cancel(cmd.silent);
        break;
      case 'paste_last':
        void this.pasteLast();
        break;
    }
  }

  // -------------------------------------------------------------------------
  // 状態の同期
  // -------------------------------------------------------------------------

  private pttState(): PttState {
    if (this.recording) return this.recording.ptt === 'locked' ? 'locked' : 'active';
    if (this.finalizing.size) return 'finalizing';
    return 'inactive';
  }

  private sync(): void {
    this.d.helper.syncState(this.pttState());
    const r = this.recording;
    const anyFinal = [...this.finalizing].sort((a, b) => b.lease - a.lease)[0];
    if (r) {
      this.d.ui.floater({
        phase: r.ptt === 'locked' ? 'locked' : 'recording',
        mode: r.mode,
        // 空白を除いた文字数（改行やインデントの多い選択で、実際より多く見えないように）
        selectionChars: r.mode === 'edit' ? (r.context?.field?.selectedText?.match(/\S/gu) ?? []).length : 0,
        startedAt: r.startedAt,
        stage: undefined,
        micReady: r.firstChunkAt !== undefined,
        micName: r.device?.name,
      });
    } else if (anyFinal) {
      this.d.ui.floater({ phase: 'finalizing', mode: anyFinal.mode, startedAt: null, micReady: false });
    } else {
      this.d.ui.floater({ phase: 'idle', mode: 'dictation', selectionChars: 0, startedAt: null, stage: undefined, micReady: false });
    }
  }

  private stage(s: Session, stage: FloaterState['stage']): void {
    if (this.recording) return;
    const newest = [...this.finalizing].sort((a, b) => b.lease - a.lease)[0];
    if (newest === s) this.d.ui.floater({ phase: 'finalizing', mode: s.mode, stage });
  }

  // -------------------------------------------------------------------------
  // 録音
  // -------------------------------------------------------------------------

  private chooseDevice(): string | null {
    const s = this.d.settings.get();
    const excluded = new Set(s.excludedMicrophones);
    const usable = this.devices.filter((x) => !excluded.has(x.id) && !x.isVirtual);
    if (s.microphoneId && usable.some((x) => x.id === s.microphoneId)) return s.microphoneId;
    const def = this.devices.find((x) => x.isDefault);
    if (!def || (!excluded.has(def.id) && !def.isVirtual)) return null; // システム既定
    return usable[0]?.id ?? null;
  }

  async refreshDevices(): Promise<AudioDevice[]> {
    try {
      const res = await this.d.helper.request<{ devices: AudioDevice[] }>('list_audio_devices', {}, 3000);
      this.devices = res.devices;
    } catch (e) {
      log.warn('マイクの一覧を取得できませんでした', e);
    }
    return this.devices;
  }

  /** マイクの接続の通知は main が出す（「マイクが見つかりません」の表示中だけ。使わない機器が増えたときには出さない） */
  private onDevicesChanged(devices: AudioDevice[]): void {
    this.devices = devices;
  }

  private start(locked: boolean): void {
    if (this.recording) return;
    if (!this.d.helper.running) {
      this.d.ui.hud('HelperFailed');
      return;
    }
    const s = this.d.settings.get();
    const lease = ++this.lease;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const session: Session = {
      lease,
      startedAt: Date.now(),
      ptt: locked ? 'locked' : 'active',
      mode: 'dictation',
      context: null,
      contextPromise: Promise.resolve(null),
      segmenter: undefined as unknown as Segmenter,
      segments: [],
      segmentSkipped: false,
      audio: 'starting',
      abort: new AbortController(),
      cancelled: false,
      done,
      resolveDone,
      finished: false,
      pendingSound: null,
      peak: 0,
      noSignalChecked: false,
      marks: {},
    };
    if (this.currentHotkey) session.clockOffset = this.currentHotkey.at - this.currentHotkey.t;
    session.segmenter = new Segmenter((start, end) => this.onSegment(session, start, end));
    session.segmenter.onPause = (end) => this.maybeSpeculate(session, end);
    this.recording = session;
    this.sync();
    // 開始音はマイクから最初の音声が届いた時点で鳴らす（届く前に話し始めて頭が切れるのを防ぐ）。届かなくても一定時間で鳴らす
    if (s.playSounds) {
      session.pendingSound = locked ? 'lock' : 'start';
      session.startSoundTimer = setTimeout(() => this.playStartSound(session), START_SOUND_FALLBACK_MS);
    }
    if (locked) this.handsFreeInfo();
    this.d.ui.preconnect();

    // 録音の開始
    this.d.helper
      .startAudio(lease, this.chooseDevice(), 4000)
      .then((res) => {
        if (session.audio === 'starting') session.audio = 'running';
        session.device = { name: res.deviceName, transport: res.transport };
        if (this.recording === session) this.d.ui.floater({ micName: res.deviceName });
        if (res.transport === 'bluetooth' && !this.shownBluetoothInfo) {
          this.shownBluetoothInfo = true;
          this.d.ui.hud('BluetoothMic');
        }
      })
      .catch((e) => {
        log.error('録音を開始できませんでした', e);
        session.audio = 'failed';
        if (this.recording === session) {
          this.d.ui.hud('MicrophoneError', { reason: (e as Error).message });
          this.cancel(true);
        }
      });

    // 文脈の取得（編集モードの判定、整形、学習に使う）
    session.contextPromise = this.d.helper
      .request<ContextPayload>('get_context', { includeField: true, includeHost: s.sendAppContext, maxContextChars: 1000 }, 1200)
      .then((ctx) => {
        session.context = ctx;
        const sel = ctx.field?.selectedText ?? '';
        if (
          s.editModeEnabled &&
          sel.trim() &&
          Array.from(sel).length <= EDIT_MAX_CHARS &&
          !ctx.field?.isSecure &&
          ctx.field?.editable !== false &&
          !TERMINAL_BUNDLES.has(ctx.app.bundleId) &&
          !/search|検索/i.test(ctx.field?.description ?? '') &&
          ctx.field?.role !== 'AXSearchField'
        ) {
          session.mode = 'edit';
          if (this.recording === session) this.sync();
        }
        return ctx;
      })
      .catch((e) => {
        log.warn('文脈を取得できませんでした', e);
        return null;
      });
  }

  private playStartSound(s: Session): void {
    if (s.startSoundTimer) clearTimeout(s.startSoundTimer);
    s.startSoundTimer = undefined;
    const sound = s.pendingSound;
    s.pendingSound = null;
    if (sound && this.recording === s) this.d.ui.sound(sound);
  }

  private dropStartSound(s: Session): void {
    if (s.startSoundTimer) clearTimeout(s.startSoundTimer);
    s.startSoundTimer = undefined;
    s.pendingSound = null;
  }

  private handsFreeInfo(): void {
    if (this.shownHandsFreeInfo) return;
    this.shownHandsFreeInfo = true;
    this.d.ui.hud('HandsFreeInfo');
  }

  private lock(): void {
    const r = this.recording;
    if (!r || r.ptt === 'locked') return;
    r.ptt = 'locked';
    if (this.d.settings.get().playSounds) {
      // まだ開始音を鳴らしていなければ、ロックの音だけを鳴らす
      this.dropStartSound(r);
      this.d.ui.sound('lock');
    }
    this.handsFreeInfo();
    this.sync();
  }

  private lastLevelAt = 0;

  private onChunk(p: AudioChunkPayload): void {
    const r = this.recording;
    const target = r && r.lease === p.sessionId ? r : [...this.finalizing].find((x) => x.lease === p.sessionId && x.audio !== 'stopped');
    if (!target) return;
    if (target.audio === 'starting') target.audio = 'running';
    // ここで話の間が見つかれば、投機的な書き起こしが始まる（onPause）
    target.segmenter.push(decodePcm(p.pcm));
    const spec = target.spec;
    if (spec && !spec.invalid && target.segmenter.speechAfter(spec.end)) {
      // 先に書き起こした範囲の後で話したので、その結果は使えない。処理中なら止めて GPU を空ける
      spec.invalid = true;
      spec.abort.abort();
    }
    if (target !== r) return;
    const now = Date.now();
    if (r.firstChunkAt === undefined) {
      r.firstChunkAt = now;
      this.playStartSound(r);
      this.d.ui.floater({ micReady: true, micName: r.device?.name });
    }
    if (r.ptt === 'active' && !r.holdHintShown && r.segmenter.length >= HOLD_LONG_HINT_SAMPLES) {
      r.holdHintShown = true;
      this.d.ui.hud('HoldLongHint');
    }
    r.peak = Math.max(r.peak, p.peak ?? 0);
    if (!r.noSignalChecked && r.segmenter.length >= NO_SIGNAL_CHECK_SAMPLES) {
      r.noSignalChecked = true;
      // 録音は続ける（ミュートを外せば、そのまま話せる）
      if (r.peak < NO_SIGNAL_PEAK) this.d.ui.hud('MicNoSignal', { micParen: r.device ? `（${r.device.name}）` : '' });
    }
    if (now - this.lastLevelAt >= 40) {
      this.lastLevelAt = now;
      this.d.ui.level(p.rms);
    }
  }

  private onAudioError(p: AudioErrorPayload): void {
    const r = this.recording;
    if (p.sessionId !== null && r && r.lease !== p.sessionId) return;
    if (!p.fatal && r) {
      // ヘルパーは既定のマイクに切り替えて録音を続けている
      log.warn(`録音中にマイクが切り替わりました: ${p.code} ${p.message}`);
      this.d.ui.hud('MicrophoneSwitched', { reason: p.message });
      return;
    }
    log.error(`録音のエラー: ${p.code} ${p.message}`);
    const key: NotificationKey = p.code === 'permission_denied' ? 'MicPermissionDenied' : p.code === 'no_device' ? 'NoMicrophone' : p.code === 'device_lost' ? 'MicrophoneLost' : 'MicrophoneError';
    this.d.ui.hud(key, { reason: p.message });
    if (r && p.fatal) {
      r.audio = 'failed';
      // 切断や音声の途絶（Bluetooth の不調など）までに録れた分は書き起こす
      if ((p.code === 'device_lost' || p.code === 'engine_failed') && r.segmenter.length > SR) void this.stop();
      else this.cancel(true);
    }
  }

  /** 録音中に区切りができたら、先に書き起こしておく */
  private onSegment(s: Session, start: number, end: number): void {
    const cfg = this.d.settings.get();
    if (!cfg.asr.incremental || !this.d.asr.ready) {
      // 区切りの位置は進んでしまうので、最後に録音全体を書き起こす
      s.segmentSkipped = true;
      return;
    }
    const prev = s.segments[s.segments.length - 1];
    const audio = s.segmenter.slice(start, end);
    const text = (async () => {
      const prompt = prev ? await prev.text.catch(() => '') : '';
      if (s.cancelled) return '';
      const hints = this.hintsFor(s.context);
      const context = prompt.slice(-200) || undefined;
      // 区間ごとの書き起こしでは、プロンプトの組み立てだけを使う（聞き直しと別候補は、丸ごとの書き起こしでだけ使う）
      const res = await this.transcribe(
        audio,
        (h) => ({
          language: cfg.language,
          hints: h,
          prompt: context,
          promptText: asrRequestExtras({ promptStyle: cfg.asr.promptStyle, promptTerms: cfg.asr.promptTerms }, h, context).promptText,
          timeoutMs: 30000,
          signal: s.abort.signal,
        }),
        hints,
      );
      return res.text;
    })();
    text.catch(() => undefined);
    s.segments.push({ start, end, text });
  }

  /**
   * 語彙ヒントの使い方（設定の asr.hintMode）に従って書き起こす。build は、渡した語をヒントにした指定を作る関数。
   * selective で、ヒントがあるときは、ヒントなしとヒントありの 2 回書き起こして、ヒントが効いた所だけを取り込む
   */
  private transcribe(samples: Float32Array, build: (hints: string[]) => TranscribeOptions, hints: string[]): Promise<AsrResultPayload> {
    if (this.d.settings.get().asr.hintMode !== 'selective' || !hints.length) return this.d.asr.transcribe(samples, build(hints));
    return transcribeSelective((opts) => this.d.asr.transcribe(samples, opts), build(hints), build([]));
  }

  /** 録音全体を書き起こす（投機と確定で同じ指定を使い、結果を入れ替えられるようにする） */
  private transcribeAll(s: Session, samples: Float32Array, durationMs: number, signal: AbortSignal): Promise<AsrResultPayload> {
    return this.transcribe(samples, (h) => this.wholeOptions(s, durationMs, signal, h), this.hintsFor(s.context));
  }

  /** 録音全体を 1 回で書き起こすときの指定 */
  private wholeOptions(s: Session, durationMs: number, signal: AbortSignal, hints: string[]): TranscribeOptions {
    const cfg = this.d.settings.get();
    const extras = asrRequestExtras(cfg.asr, hints);
    // 聞き直しは、1 回につき書き起こし 1 回分の時間がかかる
    const passes = 1 + (extras.rehear ? (extras.rehear.noHints ? 1 : 0) + (extras.rehear.temperatures?.length ?? 0) : 0);
    return {
      language: cfg.language,
      hints,
      ...extras,
      timeoutMs: (10000 + Math.ceil(durationMs / 60000) * 2000) * passes,
      signal,
    };
  }

  /**
   * 入力先の画面の文（入力欄のカーソルの前後と、ウィンドウのタイトル）から拾った、名前らしい英字の語。
   * パスワード欄の文字は使わない。辞書にある語は除く
   */
  private contextTerms(ctx: ContextPayload | null): string[] {
    if (!ctx) return [];
    const field = ctx.field && !ctx.field.isSecure ? ctx.field : undefined;
    return extractScreenTerms([field?.beforeCursor, field?.afterCursor, ctx.windowTitle], { existing: this.d.customizations.vocabulary() });
  }

  /**
   * その発話で音声認識に渡す語。辞書の語（得点順）を先に、画面の文から拾った語（設定の asr.screenTerms がオンのとき）を後に並べる。
   * 画面の語は、その発話のあいだだけ使う（辞書には入れない）
   */
  private hintsFor(ctx: ContextPayload | null): string[] {
    const hints = this.d.customizations.asrHints(this.vocabContext(ctx));
    if (!this.d.settings.get().asr.screenTerms) return hints;
    const seen = new Set(hints.map((h) => h.toLowerCase()));
    return [...hints, ...this.contextTerms(ctx).filter((t) => !seen.has(t.toLowerCase()))];
  }

  /**
   * 語彙ヒントと辞書の照合で、語に得点を付けるための文脈（入力先と最近の書き起こし。G4-09、G4-10）。
   * 入力欄の文字はパスワード欄でないときだけ使う。文脈がまだ届いていなければ、最近の書き起こしだけで付ける
   */
  private vocabContext(ctx: ContextPayload | null): { context: HintContext; recent: RecentText[] } {
    const context: HintContext = {};
    if (ctx) {
      context.bundleId = ctx.app.bundleId;
      context.host = ctx.host;
      context.windowTitle = ctx.windowTitle;
      if (ctx.field && !ctx.field.isSecure) {
        context.beforeCursor = ctx.field.beforeCursor;
        context.afterCursor = ctx.field.afterCursor;
      }
    }
    return { context, recent: this.d.history.list().slice(0, RECENT_FOR_VOCAB) };
  }

  /**
   * 話の間（発話の後の 0.3 秒の無音）で、そこまでの録音全体を先に書き起こしておく。
   * 離すまで何も話さなければ、離した後の書き起こしを待たずにこの結果を使う。
   * ASR が空いているときだけ始め、前回の範囲から 1 秒以上増えたときだけやり直す。
   */
  private maybeSpeculate(s: Session, end: number): void {
    if (s !== this.recording || s.cancelled) return;
    if (!this.d.settings.get().asr.speculative) return;
    if (end > WHOLE_MAX_SEC * SR) return;
    if (!this.d.asr.ready || !this.d.asr.idle) return;
    const prev = s.spec;
    if (prev && !prev.invalid && end - prev.end < SPEC_MIN_NEW_SAMPLES) return;
    prev?.abort.abort();
    const abort = new AbortController();
    const promise = this.transcribeAll(s, s.segmenter.slice(0, end), (end / SR) * 1000, AbortSignal.any([s.abort.signal, abort.signal]));
    promise.catch(() => undefined);
    s.spec = { end, abort, promise, invalid: false };
  }

  // -------------------------------------------------------------------------
  // 停止と確定
  // -------------------------------------------------------------------------

  private async stop(): Promise<void> {
    const s = this.recording;
    if (!s) return;
    this.recording = null;
    s.ptt = 'finalizing';
    s.stoppedAt = Date.now();
    const hk = this.currentHotkey;
    if (hk && s.clockOffset !== undefined) {
      // ヘルパーの時計（起動からの時間）と main の時計の差は、一番早く届いたイベントで決まるとみなす
      const offset = hk.at - hk.t;
      s.releaseLagMs = Math.max(0, Math.round(offset - Math.min(s.clockOffset, offset)));
    }
    this.dropStartSound(s);
    this.finalizing.add(s);
    this.sync();
    // 長い録音では開始時の事前接続が閉じられていることがある。書き起こしの間に接続し直しておく
    this.d.ui.preconnect();
    const cfg = this.d.settings.get();
    if (cfg.playSounds) this.d.ui.sound('stop');
    try {
      await this.runPipeline(s);
    } catch (e) {
      log.error('音声入力の処理で予期しないエラー', e);
      this.d.ui.hud('AsrFailed', { reason: (e as Error).message });
    } finally {
      if (s.cancelled && this.saveCancelled(s) && !s.cancelSilent) this.d.ui.hud('Cancelled');
      s.spec?.abort.abort();
      s.resolveDone();
      this.finalizing.delete(s);
      this.sync();
    }
  }

  private cancel(silent: boolean): void {
    const r = this.recording;
    if (r) {
      r.cancelled = true;
      r.cancelSilent = silent;
      r.abort.abort();
      this.recording = null;
      this.d.helper.send('audio_stop', { sessionId: r.lease });
      r.audio = 'stopped';
      r.stoppedAt = Date.now();
      this.dropStartSound(r);
      // 履歴に残したら知らせる（回数の上限と「履歴を開く」は main が付ける）
      if (this.saveCancelled(r) && !silent) this.d.ui.hud('Cancelled');
      r.resolveDone();
    }
    // 確定処理中のものも取り消す（Esc は直近の操作を取り消す）。書き起こし中の ASR も止まる
    if (!r) {
      for (const f of this.finalizing) {
        f.cancelled = true;
        f.cancelSilent = silent;
        f.abort.abort();
      }
    }
    if (!silent) {
      if (this.d.settings.get().playSounds) this.d.ui.sound('cancel');
    }
    this.sync();
  }

  private async waitAudioStopped(s: Session): Promise<void> {
    if (s.audio === 'failed') return;
    try {
      await this.d.helper.stopAudio(s.lease, 2000);
    } catch (e) {
      log.warn('録音の停止を確認できませんでした', e);
    }
    s.audio = 'stopped';
  }

  private async runPipeline(s: Session): Promise<void> {
    const cfg = this.d.settings.get();
    const t0 = s.stoppedAt ?? Date.now();
    // 話し終えてから離した（届いている音声の末尾が無音）なら、離した瞬間までの残りの音声を待たない。
    // ヘルパーは残りを集めるのに 0.1 秒ほど待ってから録音を止めるが、その分はどうせ無音である。
    // 止める要求は送り、返事だけを待たない。後から届く音声は、ここで取り出した samples には入らない
    const seg = s.segmenter;
    const quietSec = seg.lastLoudEnd > 0 ? (seg.length - seg.lastLoudEnd) / SR : 0;
    const tailMs = Math.max(0, Math.min(1000, cfg.asr.tailMs ?? 0));
    if (tailMs > 0) {
      // 話し終わりとほぼ同時にキーを離すと、文末の音が録音に入りきらない。離した後もしばらく録音を続け、
      // 止めるときはヘルパーに残っている音声も受け取る（文末の小さな音を捨てない）
      if (s.audio === 'running' && quietSec < POST_ROLL_SKIP_QUIET_SEC && !s.cancelled) {
        await delay(tailMs);
        s.postRollMs = tailMs;
      }
      await this.waitAudioStopped(s);
    } else if (s.audio === 'running' && quietSec >= TAIL_SKIP_QUIET_SEC) void this.waitAudioStopped(s);
    else await this.waitAudioStopped(s);
    s.marks.stopped = Date.now();
    if (s.cancelled) return;

    const samples = s.segmenter.all();
    const durationMs = (samples.length / SR) * 1000;
    if (durationMs < cfg.minRecordingMs) {
      log.info(`短すぎる録音を破棄しました（${Math.round(durationMs)}ms）`);
      return;
    }

    // 無音の判定（REC-5）
    const stats = s.segmenter.stats();
    if (stats.peak < 0.0005) {
      this.d.ui.hud('AllSilence', { mic: s.device?.name ?? '' });
      return;
    }
    if (isNoSpeechByLevel(stats, { silenceDetection: cfg.silenceDetection, engine: cfg.asr.engine })) {
      this.d.ui.hud('NoSpeech');
      return;
    }

    const ctx = await Promise.race([s.contextPromise, delay(1000)]);
    if (s.cancelled) return;

    // ASR（起動中や再起動中なら、準備ができるまで少し待つ）
    if (!this.d.asr.ready) {
      this.stage(s, 'transcribing');
      this.d.ui.hud('AsrWaiting');
      const ok = await this.d.asr.waitReady(ASR_READY_WAIT_MS, s.abort.signal);
      if (s.cancelled) return;
      if (!ok) {
        this.d.ui.hud('AsrNotReady', { reason: this.d.asr.message || 'ASR を起動しています' });
        this.saveFailed(s, samples, ctx, '', 'ASR が準備できていません');
        return;
      }
    }
    this.stage(s, 'transcribing');
    const asrStarted = Date.now();
    let rawText = '';
    try {
      const timeoutMs = 10000 + Math.ceil(durationMs / 60000) * 2000;
      // whisper の窓（30 秒）に収まる長さなら、区切りを使わずに丸ごと書き起こす。待ち時間は変わらず、文脈が切れない分だけ正確
      if (s.segments.length && !s.segmentSkipped && samples.length > WHOLE_MAX_SEC * SR) {
        s.spec?.abort.abort();
        const done = await Promise.all(s.segments.map((x) => x.text));
        const tail = s.segmenter.slice(s.segmenter.lastCut);
        let tailText = '';
        if (tail.length > SR * 0.3 && s.segmenter.hasPendingSpeech) {
          const hints = this.hintsFor(ctx);
          const context = done[done.length - 1]?.slice(-200);
          const res = await this.transcribe(
            tail,
            (h) => ({
              language: cfg.language,
              hints: h,
              prompt: context,
              promptText: asrRequestExtras({ promptStyle: cfg.asr.promptStyle, promptTerms: cfg.asr.promptTerms }, h, context).promptText,
              timeoutMs,
              signal: s.abort.signal,
            }),
            hints,
          );
          tailText = res.text;
        }
        rawText = joinTexts([...done, tailText], cfg.language);
      } else {
        const res = await this.transcribeWhole(s, samples, durationMs);
        rawText = res.text.trim();
        s.confidence = charConfidence(rawText, res.tokens);
        s.uncertain = uncertainOf(res);
        if (res.hintsGiven !== undefined) s.hints = { used: res.hintsUsed, given: res.hintsGiven };
      }
    } catch (e) {
      if (s.cancelled) return;
      log.error('書き起こしに失敗しました', e);
      this.d.ui.hud('AsrFailed', { reason: (e as Error).message });
      this.saveFailed(s, samples, ctx, '', `書き起こしに失敗: ${(e as Error).message}`);
      return;
    }
    const asrMs = Date.now() - asrStarted;
    s.marks.asrDone = Date.now();
    s.rawText = rawText;
    if (s.cancelled) return;
    if (!rawText.trim()) {
      this.d.ui.hud('NoSpeech');
      return;
    }

    // 整形
    this.stage(s, 'formatting');
    const custom = this.d.customizations.get();
    const provider = cfg.skipLlm ? null : this.d.provider();
    // 辞書の語との照合、語ごとの補正、確信度の対応付け、整形は postAsr にまとめてある（評価と同じ関数を通すため）
    const { fmt, fix } = await postAsr({
      mode: s.mode,
      rawText,
      confidence: s.confidence,
      uncertain: s.uncertain,
      settings: cfg,
      customizations: this.d.customizations,
      ctx,
      vocab: () => this.vocabContext(ctx),
      provider,
      tokenizer: () => this.d.tokenizer?.() ?? null,
      signal: s.abort.signal,
      log,
      onPlan: (plan) => {
        s.minConfidence = plan.minConfidence;
      },
    });
    s.marks.llmDone = Date.now();
    if (s.cancelled) return;
    if (fmt.error) log.warn(`整形の失敗（${fmt.errorKind}）: ${fmt.error}`);

    const base: HistoryItem = {
      id: randomUUID(),
      timestamp: s.startedAt,
      mode: s.mode,
      text: fmt.text,
      rawText,
      selectedText: s.mode === 'edit' ? ctx?.field?.selectedText : undefined,
      formatted: fmt.formatted,
      llmError: fmt.error,
      app: ctx ? { name: ctx.app.name, bundleId: ctx.app.bundleId } : undefined,
      host: ctx?.host,
      durationSec: Math.round(durationMs / 100) / 10,
      language: cfg.language,
      timings: { asrMs, llmMs: fmt.llmMs, totalMs: 0 },
      paste: 'skipped',
      fastPath: fmt.fastPath || undefined,
      autoFixes: fmt.autoFixed && fix?.edits.length ? fix.edits.map(({ rule, before, after }) => ({ rule, before, after })) : undefined,
      // 録音を残す設定のときは、画面から拾える語も残す（あとで「画面の語をヒントにしたら直ったか」を同じ録音で確かめるため）
      contextTerms: cfg.saveRecordings ? nonEmpty(this.contextTerms(ctx)) : undefined,
    };

    // 編集モードの結果の扱い
    if (s.mode === 'edit') {
      if (fmt.error) {
        this.d.ui.hud('EditFailed', { reason: fmt.error });
        this.finish(s, samples, { ...base, paste: 'skipped' }, t0);
        return;
      }
      if (fmt.unclear) {
        // 書き換えはしないが、何と言ったかは履歴で見られるように残す（N5）
        this.d.ui.hud('EditUnclear');
        this.finish(s, samples, { ...base, text: '', selectedText: undefined, paste: 'skipped', editUnclear: true }, t0);
        return;
      }
    } else if (!fmt.text.trim()) {
      this.d.ui.hud('NoSpeech');
      return;
    } else if (!fmt.formatted && provider) {
      this.d.ui.hud('LlmFailed', { reason: fmt.error ?? '' });
    } else if (!provider && !cfg.skipLlm) {
      this.d.ui.hud('LlmNotConfigured');
    }

    // 貼り付けは録音の順に行う。前の録音がまだ確定中なら、その貼り付けが終わるまで待つ
    const waitFrom = Date.now();
    await Promise.all([...this.finalizing].filter((f) => f.lease < s.lease).map((f) => f.done));
    s.marks.pasteWaitMs = Date.now() - waitFrom;
    if (s.cancelled) return;

    // 古い結果は貼らない（期限切れ、または次の録音が別のアプリ向けか編集モード）
    const stale = Date.now() - t0 > STALE_MS || !(await this.canPasteBeforeNewer(s, ctx));
    if (s.cancelled) return;
    if (stale) {
      this.d.ui.hud('StaleResult');
      this.finish(s, samples, { ...base, paste: 'stale' }, t0);
      return;
    }

    // 貼り付け
    this.stage(s, 'pasting');
    const text = composePaste({
      mode: s.mode,
      text: escapeTokens(fmt.text),
      deleted: fmt.deleted,
      replacements: custom.replacements,
      beforeCursor: ctx?.field?.isSecure ? undefined : ctx?.field?.beforeCursor,
      afterCursor: ctx?.field?.isSecure ? undefined : ctx?.field?.afterCursor,
    });
    const pasteId = randomUUID();
    const learn = cfg.learning.enabled && s.mode === 'dictation' && !!ctx?.field && !ctx.field.isSecure && ctx.field.editable && !TERMINAL_BUNDLES.has(ctx.app.bundleId);
    let ack: PasteAckPayload | null = null;
    if (learn) {
      // 監視の結果は paste_ack と同じ読み込みで届くことがあるので、要求を送る前に登録しておく。
      // ヘルパーは監視を始められたときだけ結果を送るので、届かなかった分は監視時間の後に捨てる
      this.pendingWatches.set(pasteId, { inserted: text, rawText });
      setTimeout(() => this.pendingWatches.delete(pasteId), cfg.learning.watchSeconds * 1000 + 30_000).unref?.();
    }
    s.marks.pasteSent = Date.now();
    try {
      ack = await this.d.helper.request<PasteAckPayload>(
        'paste',
        {
          pasteId,
          text,
          expectSelectedText: s.mode === 'edit' ? ctx?.field?.selectedText : undefined,
          verifyLanding: !(ctx && NO_LANDING_CHECK_BUNDLES.has(ctx.app.bundleId)),
          avoidClipboardHistory: cfg.avoidClipboardHistory,
          watchMs: learn ? cfg.learning.watchSeconds * 1000 : 0,
        },
        15000,
      );
    } catch (e) {
      log.error('貼り付けに失敗しました', e);
      this.d.ui.hud('PasteFailed', { reason: (e as Error).message });
    }
    s.marks.ack = Date.now();
    this.noteKeyPosted(s, ack);
    if (!ack?.success) this.pendingWatches.delete(pasteId);
    let paste: HistoryItem['paste'] = 'failed';
    if (ack?.success) {
      paste = 'pasted';
      if (ack.landed === 'unconfirmed') this.d.ui.hud('PasteUnconfirmed');
    } else if (ack) {
      switch (ack.failureReason) {
        case 'edit_target_changed':
          this.d.ui.hud('EditTargetChanged');
          break;
        case 'no_text_target':
          this.d.ui.hud('NoPaste');
          break;
        case 'not_trusted':
          this.d.ui.hud('AccessibilityMissing');
          break;
        default:
          this.d.ui.hud('PasteFailed', { reason: ack.failureReason ?? '' });
      }
    }
    this.finish(s, samples, { ...base, paste }, t0);
  }

  /**
   * 録音全体を書き起こす。話の間で先に書き起こした結果があり、その後に何も話していなければ、それを使う。
   */
  private async transcribeWhole(s: Session, samples: Float32Array, durationMs: number): Promise<AsrResultPayload> {
    const spec = s.spec;
    s.spec = undefined;
    if (spec && !spec.invalid && !s.segmenter.speechAfter(spec.end)) {
      try {
        const res = await spec.promise;
        s.specResult = 'hit';
        return res;
      } catch (e) {
        if (s.cancelled) throw e;
        if (!isAsrCancelled(e)) log.warn('先に書き起こした結果を使えませんでした', e);
      }
    } else {
      spec?.abort.abort();
    }
    if (spec) s.specResult = 'miss';
    return this.transcribeAll(s, samples, durationMs, s.abort.signal);
  }

  /**
   * 前の録音の結果を、次の録音より先に貼ってよいか。
   * 次の録音（録音中か確定中）がなければよい。あれば、どれも同じアプリ向けで、編集モードでないときだけよい。
   */
  private async canPasteBeforeNewer(s: Session, ctx: ContextPayload | null): Promise<boolean> {
    const newer = [this.recording, ...this.finalizing].filter((x): x is Session => !!x && x.lease > s.lease && !x.cancelled);
    if (!newer.length) return true;
    if (s.mode === 'edit' || !ctx) return false;
    for (const n of newer) {
      const nctx = n.context ?? (await Promise.race([n.contextPromise, delay(NEWER_CONTEXT_WAIT_MS)]));
      if (!nctx || n.mode === 'edit' || nctx.app.bundleId !== ctx.app.bundleId) return false;
    }
    return true;
  }

  /** ヘルパーが ⌘V を送った時刻を報告していれば記録する */
  private noteKeyPosted(s: Session, ack: PasteAckPayload | null): void {
    if (!ack) return;
    if (typeof ack.preReadMs === 'number') s.marks.preReadMs = ack.preReadMs;
    // keyPostedAt は hotkey の t と同じ時計なので、キーの操作で求めた差を足して ms エポックに直す
    if (typeof ack.keyPostedAt === 'number' && s.clockOffset !== undefined) s.marks.keyPosted = ack.keyPostedAt + s.clockOffset;
    else if (typeof ack.keyPostedAfterMs === 'number' && s.marks.pasteSent !== undefined) s.marks.keyPosted = s.marks.pasteSent + ack.keyPostedAfterMs;
  }

  /** 区間ごとの時間（離す操作を受けた時刻 t0 からの経過） */
  private stageTimings(s: Session, t0: number): Partial<HistoryTimings> {
    const since = (x?: number) => (x === undefined ? undefined : Math.max(0, x - t0));
    const t: Partial<HistoryTimings> = {
      releaseLagMs: s.releaseLagMs,
      stoppedMs: since(s.marks.stopped),
      postRollMs: s.postRollMs,
      asrDoneMs: since(s.marks.asrDone),
      llmDoneMs: since(s.marks.llmDone),
      pasteWaitMs: s.marks.pasteWaitMs,
      keyPostedMs: since(s.marks.keyPosted),
      ackMs: since(s.marks.ack),
      speculative: s.specResult,
    };
    for (const k of Object.keys(t) as (keyof HistoryTimings)[]) if (t[k] === undefined) delete t[k];
    return t;
  }

  private finish(s: Session, samples: Float32Array, item: HistoryItem, t0: number): void {
    const cfg = this.d.settings.get();
    s.finished = true;
    item.timings = { ...item.timings, ...this.stageTimings(s, t0), totalMs: Date.now() - t0 };
    if (cfg.saveRecordings) {
      try {
        item.audioFile = this.d.recordings.save(samples, s.startedAt);
      } catch (e) {
        log.warn('録音を保存できませんでした', e);
      }
    }
    this.d.history.add(item);
    const tm = item.timings;
    const ms = (v?: number) => (v === undefined ? '-' : `${v}ms`);
    log.info(
      `完了 mode=${item.mode} paste=${item.paste} formatted=${item.formatted} 音声=${item.durationSec}s ASR=${tm.asrMs}ms LLM=${tm.llmMs}ms 合計=${tm.totalMs}ms` +
        ` 区間（離してから）: 受信遅れ=${ms(tm.releaseLagMs)} 停止=${ms(tm.stoppedMs)} ASR=${ms(tm.asrDoneMs)} 整形=${ms(tm.llmDoneMs)}` +
        ` 順番待ち=${ms(tm.pasteWaitMs)} ⌘V=${ms(tm.keyPostedMs)}（読み取り=${ms(s.marks.preReadMs)}） ACK=${ms(tm.ackMs)} 投機=${tm.speculative ?? '-'}` +
        ` ヒント=${s.hints ? `${s.hints.used ?? '-'}/${s.hints.given}` : '-'} 確信度=${s.minConfidence?.toFixed(2) ?? '-'}${item.fastPath ? ' 近道' : ''}`,
    );
  }

  /**
   * 取り消した録音を履歴に残す（2 秒を超えるものだけ）。書き起こしは貼らず、⌃⌘V の対象にもしない。
   * 録音を保存しない設定で、書き起こしもまだなければ、残しても使い道がないので残さない。残したら true
   */
  private saveCancelled(s: Session): boolean {
    if (s.finished || s.segmenter.length <= KEEP_CANCELLED_SAMPLES) return false;
    const cfg = this.d.settings.get();
    if (!cfg.saveRecordings && !s.rawText) return false;
    const samples = s.segmenter.all();
    const ctx = s.context;
    this.finish(
      s,
      samples,
      {
        id: randomUUID(),
        timestamp: s.startedAt,
        mode: s.mode,
        text: '',
        rawText: s.rawText ?? '',
        formatted: false,
        app: ctx ? { name: ctx.app.name, bundleId: ctx.app.bundleId } : undefined,
        host: ctx?.host,
        durationSec: Math.round(samples.length / 1600) / 10,
        language: cfg.language,
        timings: { asrMs: 0, llmMs: 0, totalMs: 0 },
        paste: 'cancelled',
      },
      s.stoppedAt ?? Date.now(),
    );
    return true;
  }

  private saveFailed(s: Session, samples: Float32Array, ctx: ContextPayload | null, rawText: string, error: string): void {
    this.finish(
      s,
      samples,
      {
        id: randomUUID(),
        timestamp: s.startedAt,
        mode: s.mode,
        text: '',
        rawText,
        formatted: false,
        llmError: error,
        app: ctx ? { name: ctx.app.name, bundleId: ctx.app.bundleId } : undefined,
        durationSec: Math.round(samples.length / 1600) / 10,
        language: this.d.settings.get().language,
        timings: { asrMs: 0, llmMs: 0, totalMs: 0 },
        paste: 'failed',
      },
      s.stoppedAt ?? Date.now(),
    );
  }

  // -------------------------------------------------------------------------
  // そのほかの操作
  // -------------------------------------------------------------------------

  /** 直前の書き起こしを貼り付ける（HK-7） */
  async pasteLast(): Promise<void> {
    const last = this.d.history.last();
    if (!last?.text) {
      this.d.ui.hud('NoLastTranscript');
      return;
    }
    try {
      const ack = await this.d.helper.request<PasteAckPayload>(
        'paste',
        {
          pasteId: randomUUID(),
          text: escapeTokens(last.text),
          verifyLanding: true,
          avoidClipboardHistory: this.d.settings.get().avoidClipboardHistory,
        },
        15000,
      );
      if (ack.success) this.d.ui.hud('PastedLast');
      else if (ack.failureReason === 'no_text_target') this.d.ui.hud('NoPaste');
      else this.d.ui.hud('PasteFailed', { reason: ack.failureReason ?? '' });
    } catch (e) {
      this.d.ui.hud('PasteFailed', { reason: (e as Error).message });
    }
  }

  /** 貼り付け後の手直しから学習する（LRN-1、LRN-2） */
  private async onFieldWatch(p: FieldWatchResultPayload): Promise<void> {
    const pending = this.pendingWatches.get(p.pasteId);
    this.pendingWatches.delete(p.pasteId);
    if (!pending || !this.d.settings.get().learning.enabled) return;
    try {
      const cust = this.d.customizations;
      let tokenizer: Tokenizer | null = null;
      try {
        tokenizer = this.d.tokenizer?.() ?? null;
      } catch {
        tokenizer = null;
      }
      const r = await learnFromWatchDetailed(p, {
        inserted: pending.inserted,
        vocabulary: cust.vocabulary(),
        blocked: cust.get().blockedLearnedWords,
        provider: this.d.settings.get().skipLlm ? null : this.d.provider(),
        timeoutMs: this.d.settings.get().llm.timeoutMs,
        rawText: pending.rawText,
        tokenizer,
      });
      if (r.skipped && r.skipped !== 'no_candidates') {
        log.info(`学習しませんでした（${r.skipped}${r.method ? `、範囲: ${r.method}` : ''}${r.candidates ? `、候補 ${r.candidates} 件` : ''}）`);
      }
      const applied = applyLearning(cust, r);
      if (!applied.count) return;
      // 本文は残さず、数だけを記録する
      log.info(`手直しから学習しました（語 ${applied.words.length}、聞き違えた形 ${applied.forms.length}、取り違えの組 ${applied.corrections.length}、書き換えない語句 ${applied.kept.length}）`);
      const undo = [
        {
          id: 'undo',
          label: '取り消す',
          run: () => {
            applied.undo();
            this.d.ui.hud('WordsLearnedUndone');
          },
        },
      ];
      if (applied.words.length) {
        this.d.ui.hud('WordsLearned', { words: applied.words.map((w) => w.word).join('」「') }, undo);
      } else {
        // 辞書に語を足さない学習（聞き違えた形、取り違えの組、書き換えない語句）は、直した後の形を 1 つ見せる
        const shown = applied.forms[0]?.word ?? applied.corrections[0]?.corrected ?? applied.kept[0]?.phrase ?? '';
        this.d.ui.hud(applied.count > 1 ? 'CorrectionsLearnedMany' : 'CorrectionLearned', { text: shown, count: String(applied.count) }, undo);
      }
    } catch (e) {
      log.warn('学習に失敗しました', e);
    }
  }

  get isRecording(): boolean {
    return !!this.recording;
  }

  dispose(): void {
    this.interpreter.dispose();
    if (this.recording) this.cancel(true);
  }
}
