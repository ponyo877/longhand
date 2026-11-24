import { randomUUID } from 'node:crypto';
import type { AsrResultPayload } from '../../shared/asr-protocol';
import type { AudioChunkPayload, AudioDevice, AudioErrorPayload, ContextPayload, FieldWatchResultPayload, HelperToMain, PasteAckPayload, PttState } from '../../shared/protocol';
import type { FloaterState, HistoryItem, HistoryTimings, SoundName } from '../../shared/types';
import { isAsrCancelled, type AsrService, type TranscribeOptions } from '../asr/AsrService';
import { isNoSpeechByLevel, Segmenter, WHOLE_MAX_SEC } from '../asr/Segmenter';
import { joinTexts } from '../format/postprocess';
import type { HelperClient } from '../helper/HelperClient';
import type { MessageKey } from '../../shared/i18n';
import { t } from '../i18n';
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
/** Deadline from stop to pasting the result. Results past it are only kept in the history */
const STALE_MS = 120_000;
/** If the audio received so far ends with this much silence, go on without waiting for the rest after release (same as the silence that starts speculative transcription) */
const TAIL_SKIP_QUIET_SEC = 0.3;
/** If the audio received so far ends with at least this much silence, do not keep recording after release (asr.tailMs): the user has finished speaking */
const POST_ROLL_SKIP_QUIET_SEC = 1.0;
/** Maximum selection length handled in edit mode */
const EDIT_MAX_CHARS = 6000;
/** A canceled recording longer than this is still kept in the history with its audio (so an accidental cancel can be recovered) */
const KEEP_CANCELLED_SAMPLES = 2 * SR;
/** Speculative transcription is redone only when the audio has grown this much since the last range (to keep GPU load down) */
const SPEC_MIN_NEW_SAMPLES = 1 * SR;
/** Play the start sound after this time even if no audio has arrived */
const START_SOUND_FALLBACK_MS = 600;
/** If the peak stays low for this long after recording starts, report that no sound is coming from the microphone */
const NO_SIGNAL_CHECK_SAMPLES = 2.5 * SR;
const NO_SIGNAL_PEAK = 0.0005;
/** How long to wait when ASR is still getting ready at finalization */
const ASR_READY_WAIT_MS = 10_000;
/** Before pasting the previous recording's result, how long to wait for the newer recording's context (the target app) */
const NEWER_CONTEXT_WAIT_MS = 300;
/** After holding this long without locking, show how to lock */
const HOLD_LONG_HINT_SAMPLES = 40 * SR;
/** Number of recent transcripts used to score vocabulary hints and dictionary matching */
const RECENT_FOR_VOCAB = 100;
/**
 * Apps where the paste landing check is skipped (PST-3). In a terminal the whole screen text is the value, so scrolling output looks like a landing;
 * remote desktops and virtual machines have fields that cannot be read locally, so a check would only give false alarms
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
  /** Connects to the LLM endpoint in advance (finishing the TLS handshake while recording) */
  preconnect(): void;
}

/** Why a paste failed, for the PasteFailed notification. A code the helper adds later is shown as it is */
const PASTE_FAILURE: Record<NonNullable<PasteAckPayload['failureReason']>, MessageKey> = {
  edit_target_changed: 'engine.paste.editTargetChanged',
  app_changed: 'engine.paste.appChanged',
  no_text_target: 'engine.paste.noTextTarget',
  secure_field: 'engine.paste.secureField',
  pasteboard_error: 'engine.paste.pasteboardError',
  not_trusted: 'engine.paste.notTrusted',
};

function pasteFailureText(reason: PasteAckPayload['failureReason']): string {
  const key = reason ? PASTE_FAILURE[reason] : undefined;
  return key ? t(key) : (reason ?? '');
}

/** The parts of the helper the controller uses. The end-to-end self-test passes its own (selftest/virtualInput.ts) */
export interface HelperPort {
  on(event: 'message' | 'exit', listener: (...args: any[]) => void): unknown;
  readonly running: boolean;
  syncState: HelperClient['syncState'];
  request<T = unknown>(type: string, payload?: unknown, timeoutMs?: number): Promise<T>;
  send: HelperClient['send'];
  startAudio: HelperClient['startAudio'];
  stopAudio: HelperClient['stopAudio'];
}

export interface ControllerDeps {
  helper: HelperPort;
  asr: AsrService;
  settings: SettingsStore;
  customizations: CustomizationsStore;
  history: HistoryStore;
  recordings: RecordingStore;
  ui: UiPort;
  /** Creates an LlmProvider from the settings. null when not set up or with skipLlm */
  provider: () => LlmProvider | null;
  /** Tokenizer for textfix. null while loading or when unavailable (only the rules that need it are skipped) */
  tokenizer?: () => Tokenizer | null;
}

interface Segment {
  start: number;
  end: number;
  text: Promise<string>;
}

/** A result transcribed ahead of time during a pause (speculative transcription) */
interface Speculation {
  /** End of the transcribed range (in samples). The range starts at the beginning of the recording */
  end: number;
  abort: AbortController;
  promise: Promise<AsrResultPayload>;
  /** The user said something afterwards, so this result cannot be used */
  invalid: boolean;
}

/** Times used to measure stages (ms since the epoch) */
interface Marks {
  stopped?: number;
  asrDone?: number;
  llmDone?: number;
  pasteSent?: number;
  keyPosted?: number;
  ack?: number;
  pasteWaitMs?: number;
  /** Time the helper spent reading AX before pasting (ms) */
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
  /** Whether any segment was skipped without transcription (if so, the whole recording is transcribed at the end) */
  segmentSkipped: boolean;
  audio: 'starting' | 'running' | 'failed' | 'stopped';
  device?: { name: string; transport: string };
  abort: AbortController;
  cancelled: boolean;
  stoppedAt?: number;
  /** Resolves when finalization is done (used to paste in recording order) */
  done: Promise<void>;
  resolveDone: () => void;
  /** Whether it was saved to the history */
  finished: boolean;
  /** The transcript (to save it in the history when canceled) */
  rawText?: string;
  spec?: Speculation;
  specResult?: 'hit' | 'miss';
  /** Time the first audio chunk arrived */
  firstChunkAt?: number;
  /** Start sound not played yet */
  pendingSound: SoundName | null;
  startSoundTimer?: NodeJS.Timeout;
  /** Peak amplitude since recording started (to tell whether sound is coming from the microphone) */
  peak: number;
  noSignalChecked: boolean;
  /** Smallest difference between the helper's event times and main's clock (used to estimate the delay from key release to arrival) */
  clockOffset?: number;
  releaseLagMs?: number;
  /** How long recording continued after the key was released (only when it did) */
  postRollMs?: number;
  /** Spots speech recognition may have misheard (only when transcribed as a whole) */
  uncertain?: Uncertain[];
  marks: Marks;
  /** Canceled for a reason other than the user (an error, for example). No cancel notification is shown */
  cancelSilent?: boolean;
  /** Whether the lock hint was shown */
  holdHintShown?: boolean;
  /** Of the vocabulary hints passed to ASR, how many made it into the prompt and how many were passed (when the worker reports them) */
  hints?: { used?: number; given: number };
  /** Per-character confidence of the transcript (rawText). Only when transcribed as a whole (null for long recordings transcribed in segments) */
  confidence?: Confidence | null;
  /** Lowest confidence of the content characters (logged, as a clue for revisiting the threshold for sending to the LLM) */
  minConfidence?: number | null;
}

function decodePcm(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  // Copy into a new ArrayBuffer to avoid the offset of Buffer's pool
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}

const delay = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), ms));
const nonEmpty = <T>(list: T[]): T[] | undefined => (list.length ? list : undefined);

/**
 * Handles one dictation from start to finish (the session state machine).
 *
 * The lease ID goes up with every recording. ASR, LLM and paste results carry the lease ID from the start.
 * If a new recording starts while the previous one is finalizing, pastes happen in recording order (the previous result first).
 * If the new recording targets another app or is in edit mode, the previous result is not pasted and is only kept in the history.
 */
export class DictationController {
  private lease = 0;
  /** The session being recorded (only one) */
  private recording: Session | null = null;
  /** Sessions being finalized */
  private finalizing = new Set<Session>();
  private readonly interpreter: HotkeyInterpreter;
  private devices: AudioDevice[] = [];
  /** Pastes waiting for corrections after pasting. rawText is the transcript before formatting (used to spot corrections that undo formatting changes) */
  private pendingWatches = new Map<string, { inserted: string; rawText: string }>();
  private shownHandsFreeInfo = false;
  private shownBluetoothInfo = false;
  /** The hotkey event being handled (the helper's time t and the time main received it) */
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

  /** If the helper crashes while recording, the release will never arrive, so close the recording here */
  private onHelperExit(): void {
    const r = this.recording;
    if (!r) return;
    log.warn('the helper exited while recording');
    r.audio = 'failed';
    if (r.segmenter.length > SR) {
      this.d.ui.hud('HelperCrashed');
      void this.stop();
    } else {
      this.cancel(true);
    }
  }

  // -------------------------------------------------------------------------
  // Input
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

  /** Actions from the floating bar's buttons or the tray */
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
  // State sync
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
        // Characters without whitespace (so a selection with many line breaks or indents does not look longer than it is)
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
  // Recording
  // -------------------------------------------------------------------------

  private chooseDevice(): string | null {
    const s = this.d.settings.get();
    const excluded = new Set(s.excludedMicrophones);
    const usable = this.devices.filter((x) => !excluded.has(x.id) && !x.isVirtual);
    if (s.microphoneId && usable.some((x) => x.id === s.microphoneId)) return s.microphoneId;
    const def = this.devices.find((x) => x.isDefault);
    if (!def || (!excluded.has(def.id) && !def.isVirtual)) return null; // system default
    return usable[0]?.id ?? null;
  }

  async refreshDevices(): Promise<AudioDevice[]> {
    try {
      const res = await this.d.helper.request<{ devices: AudioDevice[] }>('list_audio_devices', {}, 3000);
      this.devices = res.devices;
    } catch (e) {
      log.warn('could not get the list of microphones', e);
    }
    return this.devices;
  }

  /** main shows the microphone-connected notification (only while “No microphone found” is shown; not when an unused device appears) */
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
    // Play the start sound when the first audio arrives from the microphone (so the user does not start speaking early and get cut off). Play it after a set time even if none arrives
    if (s.playSounds) {
      session.pendingSound = locked ? 'lock' : 'start';
      session.startSoundTimer = setTimeout(() => this.playStartSound(session), START_SOUND_FALLBACK_MS);
    }
    if (locked) this.handsFreeInfo();
    this.d.ui.preconnect();

    // Start recording
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
        log.error('could not start recording', e);
        session.audio = 'failed';
        if (this.recording === session) {
          this.d.ui.hud('MicrophoneError', { reason: (e as Error).message });
          this.cancel(true);
        }
      });

    // Get the context (used to decide edit mode, for formatting and for learning)
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
        log.warn('could not get the context', e);
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
      // If the start sound has not played yet, play only the lock sound
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
    // A pause found here starts speculative transcription (onPause)
    target.segmenter.push(decodePcm(p.pcm));
    const spec = target.spec;
    if (spec && !spec.invalid && target.segmenter.speechAfter(spec.end)) {
      // The user spoke after the range transcribed ahead, so that result cannot be used. Stop it if still running to free the GPU
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
      // Keep recording (after unmuting, the user can just go on speaking). main adds the microphone name to the message
      if (r.peak < NO_SIGNAL_PEAK) this.d.ui.hud('MicNoSignal', { mic: r.device?.name ?? '' });
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
      // The helper has switched to the default microphone and keeps recording
      log.warn(`microphone switched while recording: ${p.code} ${p.message}`);
      this.d.ui.hud('MicrophoneSwitched', { reason: p.message });
      return;
    }
    log.error(`recording error: ${p.code} ${p.message}`);
    const key: NotificationKey = p.code === 'permission_denied' ? 'MicPermissionDenied' : p.code === 'no_device' ? 'NoMicrophone' : p.code === 'device_lost' ? 'MicrophoneLost' : 'MicrophoneError';
    this.d.ui.hud(key, { reason: p.message });
    if (r && p.fatal) {
      r.audio = 'failed';
      // Transcribe what was recorded before a disconnect or an audio dropout (Bluetooth trouble, for example)
      if ((p.code === 'device_lost' || p.code === 'engine_failed') && r.segmenter.length > SR) void this.stop();
      else this.cancel(true);
    }
  }

  /** When a segment ends during recording, transcribe it ahead of time */
  private onSegment(s: Session, start: number, end: number): void {
    const cfg = this.d.settings.get();
    if (!cfg.asr.incremental || !this.d.asr.ready) {
      // The segment position has already moved on, so transcribe the whole recording at the end
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
      // Per-segment transcription uses only the prompt building (re-hearing and alternatives are used only when transcribing as a whole)
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
   * Transcribes following how vocabulary hints are used (asr.hintMode in the settings). build makes the options with the given words as hints.
   * With selective and some hints, transcribes twice, without and with hints, and takes only the spots where the hints helped
   */
  private transcribe(samples: Float32Array, build: (hints: string[]) => TranscribeOptions, hints: string[]): Promise<AsrResultPayload> {
    if (this.d.settings.get().asr.hintMode !== 'selective' || !hints.length) return this.d.asr.transcribe(samples, build(hints));
    return transcribeSelective((opts) => this.d.asr.transcribe(samples, opts), build(hints), build([]));
  }

  /** Transcribes the whole recording (speculation and finalization use the same options, so their results are interchangeable) */
  private transcribeAll(s: Session, samples: Float32Array, durationMs: number, signal: AbortSignal): Promise<AsrResultPayload> {
    return this.transcribe(samples, (h) => this.wholeOptions(s, durationMs, signal, h), this.hintsFor(s.context));
  }

  /** Options for transcribing the whole recording in one pass */
  private wholeOptions(s: Session, durationMs: number, signal: AbortSignal, hints: string[]): TranscribeOptions {
    const cfg = this.d.settings.get();
    const extras = asrRequestExtras(cfg.asr, hints);
    // Each re-hearing pass takes as long as one transcription
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
   * Latin-letter words that look like names, picked from the text on the target screen (around the cursor in the input field, and the window title).
   * Text from password fields is not used. Words already in the dictionary are left out
   */
  private contextTerms(ctx: ContextPayload | null): string[] {
    if (!ctx) return [];
    const field = ctx.field && !ctx.field.isSecure ? ctx.field : undefined;
    return extractScreenTerms([field?.beforeCursor, field?.afterCursor, ctx.windowTitle], { existing: this.d.customizations.vocabulary() });
  }

  /**
   * Words passed to speech recognition for this utterance. Dictionary words (by score) come first, then words picked from the screen text (when asr.screenTerms is on).
   * Screen words are used only for this utterance (they are not added to the dictionary)
   */
  private hintsFor(ctx: ContextPayload | null): string[] {
    const hints = this.d.customizations.asrHints(this.vocabContext(ctx));
    if (!this.d.settings.get().asr.screenTerms) return hints;
    const seen = new Set(hints.map((h) => h.toLowerCase()));
    return [...hints, ...this.contextTerms(ctx).filter((t) => !seen.has(t.toLowerCase()))];
  }

  /**
   * Context for scoring words in vocabulary hints and dictionary matching (the input target and recent transcripts; G4-09, G4-10).
   * Input field text is used only outside password fields. If the context has not arrived yet, scoring uses recent transcripts only
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
   * At a pause (0.3 seconds of silence after speech), transcribes the whole recording so far ahead of time.
   * If nothing more is said before release, this result is used without waiting for transcription after release.
   * Starts only when ASR is idle, and redoes it only when at least 1 second has been added since the last range.
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
  // Stop and finalize
  // -------------------------------------------------------------------------

  private async stop(): Promise<void> {
    const s = this.recording;
    if (!s) return;
    this.recording = null;
    s.ptt = 'finalizing';
    s.stoppedAt = Date.now();
    const hk = this.currentHotkey;
    if (hk && s.clockOffset !== undefined) {
      // Take the difference between the helper's clock (time since boot) and main's clock from the event that arrived fastest
      const offset = hk.at - hk.t;
      s.releaseLagMs = Math.max(0, Math.round(offset - Math.min(s.clockOffset, offset)));
    }
    this.dropStartSound(s);
    this.finalizing.add(s);
    this.sync();
    // After a long recording the connection made at the start may have closed. Reconnect during transcription
    this.d.ui.preconnect();
    const cfg = this.d.settings.get();
    if (cfg.playSounds) this.d.ui.sound('stop');
    try {
      await this.runPipeline(s);
    } catch (e) {
      log.error('unexpected error while processing dictation', e);
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
      // Notify when saved to the history (main adds the display limit and “Open History”)
      if (this.saveCancelled(r) && !silent) this.d.ui.hud('Cancelled');
      r.resolveDone();
    }
    // Also cancel sessions being finalized (Esc cancels the latest action). ASR in progress stops too
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
      log.warn('could not confirm that recording stopped', e);
    }
    s.audio = 'stopped';
  }

  private async runPipeline(s: Session): Promise<void> {
    const cfg = this.d.settings.get();
    const t0 = s.stoppedAt ?? Date.now();
    // If the user released after finishing speaking (the audio received so far ends in silence), do not wait for the rest of the audio up to the release.
    // The helper waits about 0.1 seconds to collect the rest before stopping, but that part is silence anyway.
    // Send the stop request, just do not wait for the reply. Audio that arrives later is not in the samples taken here
    const seg = s.segmenter;
    const quietSec = seg.lastLoudEnd > 0 ? (seg.length - seg.lastLoudEnd) / SR : 0;
    const tailMs = Math.max(0, Math.min(1000, cfg.asr.tailMs ?? 0));
    if (tailMs > 0) {
      // Releasing the key right as speech ends cuts off the end of the sentence. Keep recording for a while after release,
      // and take the audio still in the helper when stopping (so quiet sounds at the end are not dropped)
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
      log.info(`discarded a recording that was too short (${Math.round(durationMs)}ms)`);
      return;
    }

    // Silence check (REC-5)
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

    // ASR (if it is starting or restarting, wait a little until it is ready)
    if (!this.d.asr.ready) {
      this.stage(s, 'transcribing');
      this.d.ui.hud('AsrWaiting');
      const ok = await this.d.asr.waitReady(ASR_READY_WAIT_MS, s.abort.signal);
      if (s.cancelled) return;
      if (!ok) {
        this.d.ui.hud('AsrNotReady', { reason: this.d.asr.message || t('engine.session.asrStarting') });
        this.saveFailed(s, samples, ctx, '', t('engine.session.asrNotReady'));
        return;
      }
    }
    this.stage(s, 'transcribing');
    const asrStarted = Date.now();
    let rawText = '';
    try {
      const timeoutMs = 10000 + Math.ceil(durationMs / 60000) * 2000;
      // If it fits in whisper's window (30 seconds), transcribe it whole without the segments. The wait is the same, and it is more accurate because the context is not cut
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
      log.error('transcription failed', e);
      this.d.ui.hud('AsrFailed', { reason: (e as Error).message });
      this.saveFailed(s, samples, ctx, '', t('engine.session.transcriptionFailed', { reason: (e as Error).message }));
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

    // Formatting
    this.stage(s, 'formatting');
    const custom = this.d.customizations.get();
    const provider = cfg.skipLlm ? null : this.d.provider();
    // Dictionary matching, per-word fixes, confidence mapping and formatting are in postAsr (so that the evaluation runs through the same function)
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
    if (fmt.error) log.warn(`formatting failed (${fmt.errorKind}): ${fmt.error}`);

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
      // When recordings are kept, keep the words picked from the screen too (to check later, on the same recording, whether screen words as hints would have helped)
      contextTerms: cfg.saveRecordings ? nonEmpty(this.contextTerms(ctx)) : undefined,
    };

    // Handling the edit mode result
    if (s.mode === 'edit') {
      if (fmt.error) {
        this.d.ui.hud('EditFailed', { reason: fmt.error });
        this.finish(s, samples, { ...base, paste: 'skipped' }, t0);
        return;
      }
      if (fmt.unclear) {
        // Do not rewrite, but keep what was said so it can be seen in the history (N5)
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

    // Paste in recording order. If a previous recording is still finalizing, wait until its paste is done
    const waitFrom = Date.now();
    await Promise.all([...this.finalizing].filter((f) => f.lease < s.lease).map((f) => f.done));
    s.marks.pasteWaitMs = Date.now() - waitFrom;
    if (s.cancelled) return;

    // Do not paste a stale result (past the deadline, or the next recording targets another app or is in edit mode)
    const stale = Date.now() - t0 > STALE_MS || !(await this.canPasteBeforeNewer(s, ctx));
    if (s.cancelled) return;
    if (stale) {
      this.d.ui.hud('StaleResult');
      this.finish(s, samples, { ...base, paste: 'stale' }, t0);
      return;
    }

    // Paste
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
      // The watch result can arrive in the same read as paste_ack, so register it before sending the request.
      // The helper sends a result only when it could start watching, so entries without one are dropped after the watch time
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
      log.error('paste failed', e);
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
          this.d.ui.hud('PasteFailed', { reason: pasteFailureText(ack.failureReason) });
      }
    }
    this.finish(s, samples, { ...base, paste }, t0);
  }

  /**
   * Transcribes the whole recording. If a result was transcribed ahead during a pause and nothing was said after it, uses that.
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
        if (!isAsrCancelled(e)) log.warn('could not use the speculative result', e);
      }
    } else {
      spec?.abort.abort();
    }
    if (spec) s.specResult = 'miss';
    return this.transcribeAll(s, samples, durationMs, s.abort.signal);
  }

  /**
   * Whether the previous recording's result may be pasted before the next recording's.
   * Yes if there is no next recording (recording or finalizing). If there is, only when all of them target the same app and none is in edit mode.
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

  /** Records the time the helper sent ⌘V, if it reported one */
  private noteKeyPosted(s: Session, ack: PasteAckPayload | null): void {
    if (!ack) return;
    if (typeof ack.preReadMs === 'number') s.marks.preReadMs = ack.preReadMs;
    // keyPostedAt is on the same clock as the hotkey's t, so add the difference found from key events to convert it to ms since the epoch
    if (typeof ack.keyPostedAt === 'number' && s.clockOffset !== undefined) s.marks.keyPosted = ack.keyPostedAt + s.clockOffset;
    else if (typeof ack.keyPostedAfterMs === 'number' && s.marks.pasteSent !== undefined) s.marks.keyPosted = s.marks.pasteSent + ack.keyPostedAfterMs;
  }

  /** Time per stage (elapsed since t0, when the release was received) */
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
        log.warn('could not save the recording', e);
      }
    }
    this.d.history.add(item);
    const tm = item.timings;
    const ms = (v?: number) => (v === undefined ? '-' : `${v}ms`);
    log.info(
      `done mode=${item.mode} paste=${item.paste} formatted=${item.formatted} audio=${item.durationSec}s ASR=${tm.asrMs}ms LLM=${tm.llmMs}ms total=${tm.totalMs}ms` +
        ` stages (since release): releaseLag=${ms(tm.releaseLagMs)} stopped=${ms(tm.stoppedMs)} ASR=${ms(tm.asrDoneMs)} format=${ms(tm.llmDoneMs)}` +
        ` pasteWait=${ms(tm.pasteWaitMs)} ⌘V=${ms(tm.keyPostedMs)} (preRead=${ms(s.marks.preReadMs)}) ACK=${ms(tm.ackMs)} speculative=${tm.speculative ?? '-'}` +
        ` hints=${s.hints ? `${s.hints.used ?? '-'}/${s.hints.given}` : '-'} confidence=${s.minConfidence?.toFixed(2) ?? '-'}${item.fastPath ? ' fastPath' : ''}`,
    );
  }

  /**
   * Saves a canceled recording to the history (only if longer than 2 seconds). The transcript is not pasted, and ⌃⌘V does not pick it up.
   * If recordings are not kept and there is no transcript yet, saving it would be useless, so it is not saved. Returns true if saved
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
  // Other actions
  // -------------------------------------------------------------------------

  /** Pastes the last transcript (HK-7) */
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
      else this.d.ui.hud('PasteFailed', { reason: pasteFailureText(ack.failureReason) });
    } catch (e) {
      this.d.ui.hud('PasteFailed', { reason: (e as Error).message });
    }
  }

  /** Learns from corrections after pasting (LRN-1, LRN-2) */
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
        log.info(`learned nothing (${r.skipped}${r.method ? `, range: ${r.method}` : ''}${r.candidates ? `, candidates=${r.candidates}` : ''})`);
      }
      const applied = applyLearning(cust, r);
      if (!applied.count) return;
      // Log counts only, never the text
      log.info(
        `learned from a correction (words ${applied.words.length}, misheard forms ${applied.forms.length}, correction pairs ${applied.corrections.length}, kept phrases ${applied.kept.length}, ` +
          `number styles ${applied.numbers.map((n) => `${n.kind}=${n.value}`).join(',') || 0})`,
      );
      const undo = [
        {
          id: 'undo',
          label: t('engine.session.undoLearning'),
          run: () => {
            applied.undo();
            this.d.ui.hud('WordsLearnedUndone');
          },
        },
      ];
      if (applied.words.length) {
        this.d.ui.hud('WordsLearned', { words: applied.words.map((w) => w.word).join('」「') }, undo);
      } else if (applied.numbers.length === applied.count) {
        // Only how numbers are written changed: show the corrected form of the first one
        this.d.ui.hud('NumberStyleLearned', { text: applied.numbers[0].example.after }, undo);
      } else {
        // Learning that adds no dictionary word (misheard forms, correction pairs, kept phrases) shows one corrected form
        const shown = applied.forms[0]?.word ?? applied.corrections[0]?.corrected ?? applied.kept[0]?.phrase ?? applied.numbers[0]?.example.after ?? '';
        this.d.ui.hud(applied.count > 1 ? 'CorrectionsLearnedMany' : 'CorrectionLearned', { text: shown, count: String(applied.count) }, undo);
      }
    } catch (e) {
      log.warn('learning failed', e);
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
