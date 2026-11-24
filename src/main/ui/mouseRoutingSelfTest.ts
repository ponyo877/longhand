/**
 * 開発用の自己診断: フローティングバーのウィンドウが、マウスの操作を受け取る状態のまま戻らなくならないかを確かめる。
 *
 *   LONGHAND_DEBUG_SELFTEST=mouse npm start
 *
 * 画面の中にだけ合成したマウスの動きを送り（実際のポインタは動かさない）、画面の側から main への
 * 「受け取る」「通す」の知らせを記録する。結果はログに 1 行で書く。
 * 確かめること:
 * - bar:      ポインタがバーの上に来たら受け取り、離れたら通す
 * - hud:      ポインタが通知の上にあるまま通知が消えても、通す状態に戻る（以前は戻らなかった）
 * - watchdog: 画面の側からの知らせが無いまま受け取る状態になっても、main の保険が通す状態に戻す
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
  if (!win || win.isDestroyed()) return 'mouse: ウィンドウがありません';
  if (win.webContents.isLoading()) await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()));
  await wait(600);

  // main に届いた知らせを記録する
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
    if (!bar) check('bar', false, 'バーが見つからない');
    else {
      move(bar.x + bar.w / 2, bar.y + bar.h / 2);
      await wait(200);
      const entered = last() === true;
      move(5, 5);
      await wait(200);
      check('bar', entered && last() === false, `enter=${entered} leave=${last() === false}`);
    }

    // hud: 通知の上にポインタを置いたまま、通知を消す
    floater.hud({ id: 'selftest-mouse', key: 'SelfTest', kind: 'info', title: '動作確認', body: 'この通知は自動で消えます。', durationMs: 0, mutable: false, style: 'card' });
    await wait(400);
    const hud = await rect('.hud-card');
    if (!hud) check('hud', false, '通知が見つからない');
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

    // watchdog: 画面の側からの知らせなしで、受け取る状態にする
    floater.setInteractive(true);
    await wait(2000);
    check('watchdog', last() === false);
  } catch (e) {
    results.push(`error=${(e as Error).message}`);
  } finally {
    floater.setInteractive = original;
    original(false);
  }
  // 届いた知らせの並び（T: 受け取る、F: 通す）。食い違いを調べるときの手がかり
  return `mouse: ${results.join(' ')} calls=${calls.map((v) => (v ? 'T' : 'F')).join('')}`;
}

/**
 * 開発用: 通知を一定の時間だけ出して、消す。
 *
 *   LONGHAND_DEBUG_SELFTEST=mouse-hold npm start
 *
 * 上の自己診断は、画面の中に合成した動きを送る。こちらは、実際のポインタで確かめるための足場である。
 * 通知の中心の位置（画面の座標）と、出した時と消した時をログに書くので、外の道具（helper/tools/pointer-check.swift の hold）で
 * ポインタを通知の上に置いたままにして、消えた後にウィンドウがクリックを下のアプリへ通す状態に戻るかを、ウィンドウサーバーの当たり判定で見る。
 * 以前の不具合（通知を閉じた後に、画面の下部でクリックもスクロールもできなくなる）と同じ場面になる。
 */
export async function runMouseHoldSelfTest(floater: FloaterWindow, print: (line: string) => void, holdMs = 7000, afterMs = 5000): Promise<void> {
  const win = floater.win;
  if (!win || win.isDestroyed()) return print('mouse-hold: ウィンドウがありません');
  if (win.webContents.isLoading()) await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()));
  await wait(1500);
  floater.hud({ id: 'selftest-mouse-hold', key: 'SelfTest', kind: 'info', title: '動作確認', body: 'この通知は自動で消えます。', durationMs: 0, mutable: false, style: 'card' });
  await wait(500);
  const r = (await win.webContents.executeJavaScript(
    `(() => { const el = document.querySelector('.hud-card'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
  )) as Rect | null;
  if (!r) return print('mouse-hold: 通知が見つかりません');
  const b = win.getBounds();
  print(`mouse-hold: shown x=${Math.round(b.x + r.x + r.w / 2)} y=${Math.round(b.y + r.y + r.h / 2)} holdMs=${holdMs}`);
  await wait(holdMs);
  floater.dismissHud('selftest-mouse-hold');
  print('mouse-hold: dismissed');
  await wait(afterMs);
  print('mouse-hold: done');
}
