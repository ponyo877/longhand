import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HotkeyInterpreter, type Command, type InterpreterState } from './HotkeyInterpreter';

function setup(opts: { doubleTap?: boolean } = {}) {
  const state: InterpreterState = { recording: false, locked: false, finalizing: false };
  const cmds: Command[] = [];
  const it = new HotkeyInterpreter(
    () => state,
    (c) => {
      cmds.push(c);
      if (c.kind === 'start') Object.assign(state, { recording: true, locked: c.locked });
      if (c.kind === 'lock') state.locked = true;
      if (c.kind === 'stop') Object.assign(state, { recording: false, locked: false, finalizing: true });
      if (c.kind === 'cancel') Object.assign(state, { recording: false, locked: false, finalizing: false });
    },
    { doubleTapMs: () => 300, doubleTapToLock: () => opts.doubleTap ?? true },
  );
  return { it, state, cmds };
}

describe('HotkeyInterpreter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('押しっぱなしで開始し、離すと停止する', () => {
    const { it: h, cmds } = setup();
    h.handle({ action: 'activate', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'up', t: 2000 });
    expect(cmds.map((c) => c.kind)).toEqual(['start', 'stop']);
  });

  it('短いタップ 1 回は誤操作として黙って取り消す', () => {
    const { it: h, cmds } = setup();
    h.handle({ action: 'activate', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'up', t: 100 });
    vi.advanceTimersByTime(400);
    expect(cmds).toEqual([
      { kind: 'start', locked: false },
      { kind: 'cancel', silent: true },
    ]);
  });

  it('ダブルタップでロックし、もう一度押すと停止する', () => {
    const { it: h, cmds, state } = setup();
    h.handle({ action: 'activate', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'up', t: 100 });
    h.handle({ action: 'activate', phase: 'down', t: 250 });
    h.handle({ action: 'activate', phase: 'up', t: 330 });
    expect(state.locked).toBe(true);
    vi.advanceTimersByTime(1000);
    h.handle({ action: 'activate', phase: 'down', t: 5000 });
    expect(cmds.map((c) => c.kind)).toEqual(['start', 'lock', 'stop']);
  });

  it('ダブルタップが無効なら短いタップでも停止する', () => {
    const { it: h, cmds } = setup({ doubleTap: false });
    h.handle({ action: 'activate', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'up', t: 100 });
    expect(cmds.map((c) => c.kind)).toEqual(['start', 'stop']);
  });

  it('Fn を押してから Space でロックし、Fn を離しても止まらない', () => {
    const { it: h, cmds, state } = setup();
    h.handle({ action: 'activate', phase: 'down', t: 0 });
    h.handle({ action: 'lock', phase: 'down', t: 150 });
    h.handle({ action: 'lock', phase: 'up', t: 250 });
    h.handle({ action: 'activate', phase: 'up', t: 300 });
    vi.advanceTimersByTime(1000);
    expect(state.recording).toBe(true);
    expect(cmds.map((c) => c.kind)).toEqual(['start', 'lock']);
    h.handle({ action: 'lock', phase: 'down', t: 9000 });
    expect(cmds.map((c) => c.kind)).toEqual(['start', 'lock', 'stop']);
  });

  it('待機中に Lock を押すとロック状態で開始する', () => {
    const { it: h, cmds } = setup();
    h.handle({ action: 'lock', phase: 'down', t: 0 });
    expect(cmds).toEqual([{ kind: 'start', locked: true }]);
  });

  it('Fn を修飾キーとして使ったら黙って取り消す', () => {
    const { it: h, cmds } = setup();
    h.handle({ action: 'activate', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'interrupted', t: 200 });
    expect(cmds).toEqual([
      { kind: 'start', locked: false },
      { kind: 'cancel', silent: true },
    ]);
  });

  it('長く話した後の interrupted は無視する', () => {
    const { it: h, cmds } = setup();
    h.handle({ action: 'activate', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'interrupted', t: 5000 });
    expect(cmds.map((c) => c.kind)).toEqual(['start']);
  });

  it('ダブルタップの窓は 1 回目の押下から数える（離してからではない）', () => {
    const { it: h, cmds, state } = setup();
    h.handle({ action: 'activate', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'up', t: 250 });
    // 1 回目の押下から 300ms で窓が閉じる（離してから 50ms）
    vi.advanceTimersByTime(60);
    expect(cmds).toEqual([
      { kind: 'start', locked: false },
      { kind: 'cancel', silent: true },
    ]);
    // 離してから 300ms 以内でも、窓の外の 2 回目はロックにならない（クールダウン中なので開始もしない）
    h.handle({ action: 'activate', phase: 'down', t: 420 });
    expect(state.locked).toBe(false);
    expect(cmds.map((c) => c.kind)).toEqual(['start', 'cancel']);
  });

  it('停止の直後 200ms は Activate の押下で開始しない', () => {
    const { it: h, cmds } = setup();
    h.handle({ action: 'activate', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'up', t: 2000 });
    h.handle({ action: 'activate', phase: 'down', t: 2100 });
    h.handle({ action: 'activate', phase: 'up', t: 2150 });
    expect(cmds.map((c) => c.kind)).toEqual(['start', 'stop']);
    h.handle({ action: 'activate', phase: 'down', t: 2300 });
    expect(cmds.map((c) => c.kind)).toEqual(['start', 'stop', 'start']);
  });

  it('ロック中の停止の直後もクールダウンになるが、Lock キーでの開始は妨げない', () => {
    const { it: h, cmds } = setup();
    h.handle({ action: 'lock', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'down', t: 3000 });
    h.handle({ action: 'activate', phase: 'up', t: 3050 });
    h.handle({ action: 'activate', phase: 'down', t: 3100 });
    expect(cmds.map((c) => c.kind)).toEqual(['start', 'stop']);
    h.handle({ action: 'lock', phase: 'down', t: 3120 });
    expect(cmds).toEqual([{ kind: 'start', locked: true }, { kind: 'stop' }, { kind: 'start', locked: true }]);
  });

  it('Esc は録音中と確定処理中だけ取り消しになる', () => {
    const { it: h, cmds, state } = setup();
    h.handle({ action: 'cancel', phase: 'down', t: 0 });
    expect(cmds).toEqual([]);
    state.finalizing = true;
    h.handle({ action: 'cancel', phase: 'down', t: 10 });
    expect(cmds).toEqual([{ kind: 'cancel', silent: false }]);
  });
});
