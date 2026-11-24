import type { HotkeyPayload } from '../../shared/protocol';

export type Command = { kind: 'start'; locked: boolean } | { kind: 'lock' } | { kind: 'stop' } | { kind: 'cancel'; silent: boolean } | { kind: 'paste_last' };

export interface InterpreterState {
  /** 録音中か（finalizing は含まない） */
  recording: boolean;
  locked: boolean;
  /** 確定処理中のセッションがあるか（Esc の対象になる） */
  finalizing: boolean;
}

export interface InterpreterOptions {
  /** ダブルタップの窓。1 回目の押下から 2 回目の押下までの時間で測る */
  doubleTapMs: () => number;
  doubleTapToLock: () => boolean;
  /** Fn を修飾キーとして使ったとみなして取り消す、録音開始からの時間の上限 */
  interruptCancelMs?: number;
  /** 停止や取り消しの直後に、Activate の押下で新しい録音を始めない時間（チャタリング、押し直し対策） */
  cooldownMs?: number;
}

/** ダブルタップの窓の既定値（settings.doubleTapMs が無いときの値の目安） */
export const DEFAULT_DOUBLE_TAP_MS = 400;
export const DEFAULT_COOLDOWN_MS = 200;

/**
 * ヘルパーから来るホットキーのイベントを、録音の操作に翻訳する（HK-1〜5）。
 * - Activate を押している間だけ録音する（押しっぱなし）
 * - Activate のダブルタップ、または Lock で、ハンズフリー（ロック）にする
 *   ダブルタップは「1 回目の押下から doubleTapMs 以内に 2 回目を押した」ときだけ成立する
 * - ロック中に Activate か Lock を押すと停止する
 * - Esc で取り消す
 * - Activate を修飾キーとして使った（Fn+Delete など）ら、録音開始直後なら黙って取り消す
 * - 停止や取り消しの直後 cooldownMs の間は、Activate の押下で録音を始めない
 *
 * 状態は呼び出し側（DictationController）が持ち、getState で渡す。時刻はイベントの t を使う。
 */
export class HotkeyInterpreter {
  private downAt = 0;
  private tapTimer: NodeJS.Timeout | null = null;
  /** 最後に停止か取り消しをした時刻（イベントの t の基準）。クールダウンに使う */
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
            // ダブルタップの 2 回目（タイマーは 1 回目の押下から doubleTapMs で切れるので、ここに来れば窓の内側）
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
            // 短いタップ。1 回目の押下から window までに 2 回目が来なければ、誤操作として取り消す
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
