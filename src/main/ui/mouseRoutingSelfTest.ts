/**
 * Development self-test: checks that the floating bar's window never gets stuck taking mouse events.
 *
 *   LONGHAND_DEBUG_SELFTEST=mouse npm start
 *
 * Sends synthetic mouse moves into the page only (the real pointer does not move) and records the "take" and "pass" signals
 * from the renderer to main. The result is written to the log on one line.
 * What it checks:
 * - bar:      takes events when the pointer is over the bar, and passes them when it leaves
 * - hud:      goes back to passing events when a notification disappears with the pointer still over it (it used not to)
 * - watchdog: main's safeguard goes back to passing events when the window takes them without signals from the renderer
 */
import type { FloaterWindow } from './windows';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function runMouseRoutingSelfTest(floater: FloaterWindow): Promise<string> {
  const win = floater.win;
  if (!win || win.isDestroyed()) return 'mouse: no window';
  if (win.webContents.isLoading()) await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()));
  await wait(600);

  // Record the signals that reach main
  const calls: boolean[] = [];
  const original = floater.setInteractive.bind(floater);
  floater.setInteractive = (v: boolean) => {
    calls.push(v);
    original(v);
  };
  const last = () => calls[calls.length - 1];
  const rect = (selector: string) =>
    win.webContents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
    ) as Promise<Rect | null>;
  const move = (x: number, y: number) => win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
  const results: string[] = [];
  const check = (name: string, ok: boolean, note = '') => results.push(`${name}=${ok ? 'ok' : `NG${note ? `(${note})` : ''}`}`);

  try {
    // bar
    const bar = await rect('.pill');
    if (!bar) check('bar', false, 'bar not found');
    else {
      move(bar.x + bar.w / 2, bar.y + bar.h / 2);
      await wait(200);
      const entered = last() === true;
      move(5, 5);
      await wait(200);
      check('bar', entered && last() === false, `enter=${entered} leave=${last() === false}`);
    }

    // hud: dismiss a notification while the pointer stays over it
    floater.hud({ id: 'selftest-mouse', key: 'SelfTest', kind: 'info', title: 'Self-test', body: 'This notification closes by itself.', durationMs: 0, mutable: false, style: 'card' });
    await wait(400);
    const hud = await rect('.hud-card');
    if (!hud) check('hud', false, 'notification not found');
    else {
      move(hud.x + hud.w / 2, hud.y + hud.h / 2);
      await wait(200);
      const entered = last() === true;
      floater.dismissHud('selftest-mouse');
      await wait(700);
      check('hud', entered && last() === false, `enter=${entered} released=${last() === false}`);
    }
    move(5, 5);
    await wait(200);

    // watchdog: take events with no signals from the renderer
    floater.setInteractive(true);
    await wait(2000);
    check('watchdog', last() === false);
  } catch (e) {
    results.push(`error=${(e as Error).message}`);
  } finally {
    floater.setInteractive = original;
    original(false);
  }
  // Sequence of signals received (T: take, F: pass). A clue when investigating a mismatch
  return `mouse: ${results.join(' ')} calls=${calls.map((v) => (v ? 'T' : 'F')).join('')}`;
}

/**
 * Development: shows a notification for a fixed time, then dismisses it.
 *
 *   LONGHAND_DEBUG_SELFTEST=mouse-hold npm start
 *
 * The self-test above sends synthetic moves into the page. This one is scaffolding for checking with the real pointer.
 * It logs the center of the notification (screen coordinates) and when it was shown and dismissed. An external tool
 * (hold in helper/tools/pointer-check.swift) keeps the pointer over the notification, and the window server's hit testing shows whether
 * the window goes back to passing clicks to the app below after the notification disappears.
 * This reproduces the earlier bug (after a notification closed, nothing could be clicked or scrolled at the bottom of the screen).
 */
export async function runMouseHoldSelfTest(floater: FloaterWindow, print: (line: string) => void, holdMs = 7000, afterMs = 5000): Promise<void> {
  const win = floater.win;
  if (!win || win.isDestroyed()) return print('mouse-hold: no window');
  if (win.webContents.isLoading()) await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()));
  await wait(1500);
  floater.hud({ id: 'selftest-mouse-hold', key: 'SelfTest', kind: 'info', title: 'Self-test', body: 'This notification closes by itself.', durationMs: 0, mutable: false, style: 'card' });
  await wait(500);
  const r = (await win.webContents.executeJavaScript(
    `(() => { const el = document.querySelector('.hud-card'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
  )) as Rect | null;
  if (!r) return print('mouse-hold: notification not found');
  const b = win.getBounds();
  print(`mouse-hold: shown x=${Math.round(b.x + r.x + r.w / 2)} y=${Math.round(b.y + r.y + r.h / 2)} holdMs=${holdMs}`);
  await wait(holdMs);
  floater.dismissHud('selftest-mouse-hold');
  print('mouse-hold: dismissed');
  await wait(afterMs);
  print('mouse-hold: done');
}
