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

  it('starts on press and stops on release', () => {
    const { it: h, cmds } = setup();
    h.handle({ action: 'activate', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'up', t: 2000 });
    expect(cmds.map((c) => c.kind)).toEqual(['start', 'stop']);
  });

  it('silently cancels a single short tap as a mistake', () => {
    const { it: h, cmds } = setup();
    h.handle({ action: 'activate', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'up', t: 100 });
    vi.advanceTimersByTime(400);
    expect(cmds).toEqual([
      { kind: 'start', locked: false },
      { kind: 'cancel', silent: true },
    ]);
  });

  it('locks on a double tap and stops on the next press', () => {
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

  it('stops even on a short tap when double tap is off', () => {
    const { it: h, cmds } = setup({ doubleTap: false });
    h.handle({ action: 'activate', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'up', t: 100 });
    expect(cmds.map((c) => c.kind)).toEqual(['start', 'stop']);
  });

  it('locks with Space while Fn is held, and keeps going after Fn is released', () => {
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

  it('starts locked when Lock is pressed while idle', () => {
    const { it: h, cmds } = setup();
    h.handle({ action: 'lock', phase: 'down', t: 0 });
    expect(cmds).toEqual([{ kind: 'start', locked: true }]);
  });

  it('silently cancels when Fn is used as a modifier', () => {
    const { it: h, cmds } = setup();
    h.handle({ action: 'activate', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'interrupted', t: 200 });
    expect(cmds).toEqual([
      { kind: 'start', locked: false },
      { kind: 'cancel', silent: true },
    ]);
  });

  it('ignores interrupted after a long recording', () => {
    const { it: h, cmds } = setup();
    h.handle({ action: 'activate', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'interrupted', t: 5000 });
    expect(cmds.map((c) => c.kind)).toEqual(['start']);
  });

  it('counts the double-tap window from the first press (not from the release)', () => {
    const { it: h, cmds, state } = setup();
    h.handle({ action: 'activate', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'up', t: 250 });
    // The window closes 300 ms after the first press (50 ms after the release)
    vi.advanceTimersByTime(60);
    expect(cmds).toEqual([
      { kind: 'start', locked: false },
      { kind: 'cancel', silent: true },
    ]);
    // A second press outside the window does not lock, even within 300 ms of the release (and does not start either, because of the cooldown)
    h.handle({ action: 'activate', phase: 'down', t: 420 });
    expect(state.locked).toBe(false);
    expect(cmds.map((c) => c.kind)).toEqual(['start', 'cancel']);
  });

  it('does not start on Activate for 200 ms right after a stop', () => {
    const { it: h, cmds } = setup();
    h.handle({ action: 'activate', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'up', t: 2000 });
    h.handle({ action: 'activate', phase: 'down', t: 2100 });
    h.handle({ action: 'activate', phase: 'up', t: 2150 });
    expect(cmds.map((c) => c.kind)).toEqual(['start', 'stop']);
    h.handle({ action: 'activate', phase: 'down', t: 2300 });
    expect(cmds.map((c) => c.kind)).toEqual(['start', 'stop', 'start']);
  });

  it('applies the cooldown after stopping a locked recording, but still allows a start with the Lock key', () => {
    const { it: h, cmds } = setup();
    h.handle({ action: 'lock', phase: 'down', t: 0 });
    h.handle({ action: 'activate', phase: 'down', t: 3000 });
    h.handle({ action: 'activate', phase: 'up', t: 3050 });
    h.handle({ action: 'activate', phase: 'down', t: 3100 });
    expect(cmds.map((c) => c.kind)).toEqual(['start', 'stop']);
    h.handle({ action: 'lock', phase: 'down', t: 3120 });
    expect(cmds).toEqual([{ kind: 'start', locked: true }, { kind: 'stop' }, { kind: 'start', locked: true }]);
  });

  it('cancels with Esc only while recording or finalizing', () => {
    const { it: h, cmds, state } = setup();
    h.handle({ action: 'cancel', phase: 'down', t: 0 });
    expect(cmds).toEqual([]);
    state.finalizing = true;
    h.handle({ action: 'cancel', phase: 'down', t: 10 });
    expect(cmds).toEqual([{ kind: 'cancel', silent: false }]);
  });
});
