import type { HotkeyPayload } from '../../shared/protocol';

export type Command = { kind: 'start'; locked: boolean } | { kind: 'lock' } | { kind: 'stop' } | { kind: 'cancel'; silent: boolean } | { kind: 'paste_last' };

export interface InterpreterState {
  /** Whether recording (finalizing does not count) */
  recording: boolean;
  locked: boolean;
  /** Whether a session is finalizing (Esc applies to it) */
  finalizing: boolean;
}

export interface InterpreterOptions {
  /** Double-tap window, measured from the first press to the second press */
  doubleTapMs: () => number;
  doubleTapToLock: () => boolean;
  /** Time since recording started within which Fn counts as used as a modifier, and the recording is canceled */
  interruptCancelMs?: number;
  /** Time right after a stop or cancel during which pressing Activate does not start a new recording (against key bounce and re-presses) */
  cooldownMs?: number;
}

/** Default double-tap window (a guide value for when settings.doubleTapMs is missing) */
export const DEFAULT_DOUBLE_TAP_MS = 400;
export const DEFAULT_COOLDOWN_MS = 200;

/**
 * Translates hotkey events from the helper into recording commands (HK-1 to 5).
 * - Records only while Activate is held (push to talk)
 * - A double tap of Activate, or Lock, switches to hands-free (locked)
 *   A double tap counts only when the second press comes within doubleTapMs of the first press
 * - Pressing Activate or Lock while locked stops
 * - Esc cancels
 * - If Activate is used as a modifier (Fn+Delete and so on) right after recording starts, the recording is canceled silently
 * - For cooldownMs right after a stop or cancel, pressing Activate does not start recording
 *
 * The caller (DictationController) holds the state and passes it through getState. Times come from the event's t.
 */
export class HotkeyInterpreter {
  private downAt = 0;
  private tapTimer: NodeJS.Timeout | null = null;
  /** Time of the last stop or cancel (on the clock of the event's t). Used for the cooldown */
  private endedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly getState: () => InterpreterState,
    private readonly exec: (cmd: Command) => void,
    private readonly opts: InterpreterOptions,
  ) {}

  private clearTap(): boolean {
    if (!this.tapTimer) return false;
    clearTimeout(this.tapTimer);
    this.tapTimer = null;
    return true;
  }

  private end(cmd: Command & { kind: 'stop' | 'cancel' }, t: number): void {
    this.endedAt = t;
    this.exec(cmd);
  }

  private inCooldown(t: number): boolean {
    return t - this.endedAt < (this.opts.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  }

  handle(ev: HotkeyPayload): void {
    const s = this.getState();
    switch (ev.action) {
      case 'activate':
        if (ev.phase === 'down') {
          if (this.clearTap()) {
            // Second tap of a double tap (the timer expires doubleTapMs after the first press, so reaching here means inside the window)
            if (s.recording) this.exec({ kind: 'lock' });
            return;
          }
          if (s.recording && s.locked) {
            this.end({ kind: 'stop' }, ev.t);
            return;
          }
          if (!s.recording) {
            if (this.inCooldown(ev.t)) return;
            this.downAt = ev.t;
            this.exec({ kind: 'start', locked: false });
          }
        } else if (ev.phase === 'up') {
          if (!s.recording || s.locked) return;
          const held = ev.t - this.downAt;
          const window = this.opts.doubleTapMs();
          if (this.opts.doubleTapToLock() && held < window) {
            // A short tap. If no second press comes within window of the first press, cancel it as a mistake
            const expiresAt = this.downAt + window;
            this.tapTimer = setTimeout(
              () => {
                this.tapTimer = null;
                const now = this.getState();
                if (now.recording && !now.locked) this.end({ kind: 'cancel', silent: true }, expiresAt);
              },
              Math.max(0, window - held),
            );
            return;
          }
          this.end({ kind: 'stop' }, ev.t);
        } else if (ev.phase === 'interrupted') {
          if (s.recording && !s.locked && ev.t - this.downAt < (this.opts.interruptCancelMs ?? 1500)) {
            this.clearTap();
            this.end({ kind: 'cancel', silent: true }, ev.t);
          }
        }
        return;
      case 'lock':
        if (ev.phase !== 'down') return;
        this.clearTap();
        if (!s.recording) this.exec({ kind: 'start', locked: true });
        else if (!s.locked) this.exec({ kind: 'lock' });
        else this.end({ kind: 'stop' }, ev.t);
        return;
      case 'cancel':
        if (ev.phase !== 'down') return;
        if (s.recording || s.finalizing) {
          this.clearTap();
          this.end({ kind: 'cancel', silent: false }, ev.t);
        }
        return;
      case 'paste_last':
        if (ev.phase === 'down') this.exec({ kind: 'paste_last' });
        return;
    }
  }

  dispose(): void {
    this.clearTap();
  }
}
