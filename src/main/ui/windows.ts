import path from 'node:path';
import { app, BrowserWindow, screen, shell } from 'electron';
import type { FloaterState, HudMessage, SoundName } from '../../shared/types';

declare const UI_VITE_DEV_SERVER_URL: string | undefined;
declare const UI_VITE_NAME: string;

const FLOATER_W = 400;
const FLOATER_H = 260;
/** 画面の側からの「操作を受け取る」の知らせが、これだけ途切れたら、下のアプリに通す状態に戻す */
const INTERACTIVE_KEEPALIVE_MS = 1500;

function rendererUrl(page: 'floater' | 'management'): { url?: string; file?: string } {
  if (typeof UI_VITE_DEV_SERVER_URL !== 'undefined' && UI_VITE_DEV_SERVER_URL) {
    return { url: `${UI_VITE_DEV_SERVER_URL}/${page}.html` };
  }
  return { file: path.join(__dirname, `../renderer/${UI_VITE_NAME}/${page}.html`) };
}

function load(win: BrowserWindow, page: 'floater' | 'management'): void {
  const r = rendererUrl(page);
  if (r.url) void win.loadURL(r.url);
  else void win.loadFile(r.file!);
}

function secure(win: BrowserWindow): void {
  // 外部の URL を開かせない
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:') && !url.startsWith('http://localhost')) e.preventDefault();
  });
}

const preload = () => path.join(__dirname, 'preload.cjs');

/**
 * フローティングバー（UI-1、UI-2）。
 * type: 'panel' と focusable: false でフォーカスを奪わない。透明な部分はクリックを下のアプリに通す。
 * HUD 通知も同じウィンドウのバーの上に積む。
 */
export class FloaterWindow {
  win: BrowserWindow | null = null;
  private state: FloaterState = { phase: 'idle', mode: 'dictation', selectionChars: 0, startedAt: null, visible: true };

  create(): void {
    const win = new BrowserWindow({
      width: FLOATER_W,
      height: FLOATER_H,
      type: 'panel',
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      hasShadow: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preload(),
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setIgnoreMouseEvents(true, { forward: true });
    secure(win);
    load(win, 'floater');
    // 画面を読み込み直すときと、描画のプロセスが落ちたときは、操作を下のアプリに通す状態に戻す
    win.webContents.on('did-start-loading', () => this.setInteractive(false));
    win.webContents.on('render-process-gone', () => this.setInteractive(false));
    win.webContents.on('did-finish-load', () => {
      this.setInteractive(false);
      this.reposition();
      win.showInactive();
      this.send('floater:state', this.state);
    });
    this.win = win;
    // 録音中と処理中はバーを動かさない（話している途中で別の画面に移ると見失う）
    const repositionIfIdle = () => this.state.phase === 'idle' && this.reposition();
    screen.on('display-metrics-changed', repositionIfIdle);
    screen.on('display-added', repositionIfIdle);
    screen.on('display-removed', () => this.reposition());
    // 待機中は、マウスのあるディスプレイについていく（F7）
    setInterval(() => {
      if (this.state.phase !== 'idle' || !this.win || this.win.isDestroyed()) return;
      const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      if (d.id !== this.displayId) this.reposition();
    }, 250).unref?.();
  }

  private displayId: number | null = null;

  /** マウスのあるディスプレイの下端中央に置く */
  reposition(): void {
    if (!this.win) return;
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    this.displayId = d.id;
    const wa = d.workArea;
    const x = Math.round(wa.x + (wa.width - FLOATER_W) / 2);
    const y = Math.round(wa.y + wa.height - FLOATER_H - 8);
    this.win.setBounds({ x, y, width: FLOATER_W, height: FLOATER_H });
  }

  setState(patch: Partial<FloaterState>): void {
    const prevPhase = this.state.phase;
    this.state = { ...this.state, ...patch };
    if (prevPhase === 'idle' && this.state.phase !== 'idle') this.reposition();
    this.send('floater:state', this.state);
  }

  getState(): FloaterState {
    return this.state;
  }

  level(rms: number): void {
    this.send('floater:level', rms);
  }

  hud(m: HudMessage): void {
    this.send('floater:hud', m);
  }

  dismissHud(id: string): void {
    this.send('floater:hud-dismiss', id);
  }

  sound(name: SoundName, volume: number): void {
    this.send('floater:sound', { name, volume });
  }

  private interactiveWatch: NodeJS.Timeout | null = null;
  private interactiveAt = 0;

  /**
   * マウスの操作を、このウィンドウが受け取るか（true）、下のアプリに通すか（false）。
   * 受け取る状態のまま戻らないと、画面の下部（ウィンドウの 400×260 の範囲）でクリックもスクロールもできなくなる。
   * そこで、受け取る状態には期限を付ける。画面の側は、ポインタがバーや通知の上にあるあいだ、true を送り続ける（mouseRouting.ts）。
   * 知らせが途切れたとき（画面の側が止まった、など）と、ポインタがウィンドウの外に出たときは、通す状態に戻す
   */
  setInteractive(interactive: boolean): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setIgnoreMouseEvents(!interactive, { forward: true });
    if (!interactive) {
      if (this.interactiveWatch) clearInterval(this.interactiveWatch);
      this.interactiveWatch = null;
      return;
    }
    this.interactiveAt = Date.now();
    this.interactiveWatch ??= setInterval(() => {
      if (!this.win || this.win.isDestroyed()) return this.setInteractive(false);
      const p = screen.getCursorScreenPoint();
      const b = this.win.getBounds();
      const outside = p.x < b.x || p.x >= b.x + b.width || p.y < b.y || p.y >= b.y + b.height;
      if (outside || Date.now() - this.interactiveAt > INTERACTIVE_KEEPALIVE_MS) this.setInteractive(false);
    }, 200);
  }

  private send(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }
}

/** 管理ウィンドウ（MGT-1）。履歴、スタイル、設定、初回の案内 */
export class ManagementWindow {
  win: BrowserWindow | null = null;
  private pendingPage: string | null = null;

  open(page?: string): void {
    // 開いている間だけ Dock に出し、⌘Tab で戻れるようにする（S4）
    void app.dock?.show();
    if (this.win && !this.win.isDestroyed()) {
      if (page) this.win.webContents.send('nav', page);
      this.win.show();
      this.win.focus();
      app.focus({ steal: true });
      return;
    }
    const win = new BrowserWindow({
      width: 1040,
      height: 720,
      minWidth: 820,
      minHeight: 560,
      show: false,
      title: 'Longhand',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      backgroundColor: '#00000000',
      webPreferences: { preload: preload(), contextIsolation: true, sandbox: true },
    });
    secure(win);
    this.pendingPage = page ?? null;
    load(win, 'management');
    win.once('ready-to-show', () => {
      win.show();
      app.focus({ steal: true });
    });
    win.webContents.on('did-finish-load', () => {
      if (this.pendingPage) win.webContents.send('nav', this.pendingPage);
      this.pendingPage = null;
    });
    win.on('closed', () => {
      this.win = null;
      app.dock?.hide();
    });
    this.win = win;
  }

  send(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  get isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  close(): void {
    this.win?.close();
  }
}
