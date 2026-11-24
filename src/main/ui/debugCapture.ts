import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { EngineStatus, HistoryItem, PermissionStatus } from '../../shared/types';
import { currentLocale, t } from '../i18n';
import type { FloaterWindow, ManagementWindow } from './windows';
import { buildHud, type NotificationKey } from './notifications';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function capture(win: BrowserWindow | null, file: string): Promise<void> {
  if (!win || win.isDestroyed()) return;
  const img = await win.webContents.capturePage();
  fs.writeFileSync(file, img.toPNG());
}

export interface CaptureHooks {
  floater: FloaterWindow;
  management: ManagementWindow;
  quit: () => void;
  /** Temporarily changes permissions and state (to check banners and the preparing state). An empty object restores them */
  override: (o: { permissions?: Partial<PermissionStatus>; status?: Partial<EngineStatus>; history?: HistoryItem[] }) => void;
  /** Placeholder values for notifications (the actual key bindings) */
  hotkeyVars: () => Record<string, string>;
}

/** Simulates hovering over an element in the page (React's onMouseEnter is derived from mouseover) */
async function pointer(win: BrowserWindow | null, selector: string, type: 'mouseover' | 'mouseout'): Promise<void> {
  await win?.webContents.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, { bubbles: true })); })()`,
  );
}

/** Sample items for checking the history page (to see each kind of badge) */
function sampleHistory(): HistoryItem[] {
  const now = Date.now();
  const timings = { asrMs: 420, llmMs: 610, totalMs: 1180 };
  const base = { formatted: true, durationSec: 4.2, language: 'ja', timings, paste: 'pasted' as const, app: { name: 'メモ', bundleId: 'sample.notes' } };
  return [
    { ...base, id: 's1', timestamp: now - 60_000, mode: 'dictation', rawText: 'あしたのていれいは じゅうじからです', text: '明日の定例は10時からです。' },
    {
      ...base,
      id: 's2',
      timestamp: now - 120_000,
      mode: 'dictation',
      rawText: 'よろしくお願いします。',
      text: 'よろしくお願いします。',
      formatted: false,
      fastPath: true,
      timings: { ...timings, llmMs: 0 },
    },
    { ...base, id: 's3', timestamp: now - 180_000, mode: 'edit', rawText: 'えーと', text: '', selectedText: '来週の予定を確認してください。', editUnclear: true },
    { ...base, id: 's4', timestamp: now - 240_000, mode: 'dictation', rawText: '', text: '', paste: 'cancelled', audioFile: 'sample.wav', durationSec: 3.1 },
  ];
}

/** Samples for checking the dictionary candidate search (made-up sentences with Latin-script words) */
function sampleHistoryWithTerms(): HistoryItem[] {
  const now = Date.now();
  const base = { formatted: true, durationSec: 4.2, language: 'ja', timings: { asrMs: 420, llmMs: 610, totalMs: 1180 }, paste: 'pasted' as const, mode: 'dictation' as const };
  const texts = [
    'Grafana のダッシュボードで、昨日のエラーの数を確認してください。',
    'まず Grafana を開いて、次に Sentry の通知を見ます。',
    'この変更は GitHub Actions のテストが通ってから取り込みます。',
    'GitHub Actions の実行時間が長いので、キャッシュを見直します。',
    'Terraform の定義を直して、Kubernetes の設定に反映します。',
    '議事録は Notion にまとめて、リンクを Slack で共有します。',
    'Sentry のエラーを見ると、TypeScript の型の定義が古いようです。',
  ];
  return texts.map((text, i) => ({ ...base, id: `t${i}`, timestamp: now - (i + 1) * 60_000, rawText: text, text }));
}

/** Clicks a button by its text */
async function clickText(win: BrowserWindow | null, text: string): Promise<void> {
  await win?.webContents.executeJavaScript(`(() => { const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}); if (el) el.click(); })()`);
}

async function closeAllHuds(win: BrowserWindow | null): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await win?.webContents.executeJavaScript(`[...document.querySelectorAll(${JSON.stringify(`button[aria-label=${JSON.stringify(t('floater.hud.close'))}]`)})].forEach((b) => b.click())`);
    await wait(120);
  }
}

/**
 * Development. Launched with LONGHAND_DEBUG_CAPTURE=<directory>, writes each page and state of the floating bar to PNG files and quits.
 * It is for checking the interface without capturing the user's whole screen.
 * Notifications are shown directly, not through main's showHud, so that no display counts are recorded.
 *
 * Buttons are found by their text in the current interface language. To capture both languages without showing your own data, run
 * it twice in a temporary profile: LONGHAND_DEBUG_PROFILE=temp LONGHAND_DEBUG_UI_LANGUAGE=en (then ja) LONGHAND_DEBUG_CAPTURE=<dir>.
 */
export async function runDebugCapture(dir: string, h: CaptureHooks): Promise<void> {
  const { floater, management } = h;
  const mw = () => management.win;
  fs.mkdirSync(dir, { recursive: true });
  await wait(2500);
  for (const page of ['onboarding', 'history', 'style', 'settings', 'settings/keyboard', 'settings/dictation', 'settings/audio', 'settings/connection', 'settings/about']) {
    management.open(page);
    await wait(1000);
    await capture(mw(), path.join(dir, `management-${page.replace('/', '-')}.png`));
    // For long pages, also capture the page scrolled to the bottom
    const scrolled = await mw()?.webContents.executeJavaScript(
      `(() => { const el = [...document.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY !== 'visible'); if (!el) return false; el.scrollTop = el.scrollHeight; return true; })()`,
    );
    if (scrolled) {
      await wait(300);
      await capture(mw(), path.join(dir, `management-${page.replace('/', '-')}-bottom.png`));
    }
  }

  // Each step of first-run setup (click the step name in the sidebar)
  const steps = { microphone: 'onboarding.step.microphone', accessibility: 'onboarding.step.accessibility', 'key-test': 'onboarding.step.keyTest', try: 'onboarding.step.try' } as const;
  for (const [name, label] of Object.entries(steps)) {
    management.open('onboarding');
    await wait(500);
    await clickText(mw(), t(label));
    await wait(1200);
    await capture(mw(), path.join(dir, `onboarding-${name}.png`));
  }

  // History badges and the edit field (G4-08). Shows sample history (not saved)
  h.override({ history: sampleHistory() });
  management.open('history');
  await wait(900);
  await capture(mw(), path.join(dir, 'management-history-sample.png'));
  await mw()?.webContents.executeJavaScript(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(t('history.item.edit'))}); if (b) b.click(); })()`,
  );
  await wait(500);
  await capture(mw(), path.join(dir, 'management-history-edit.png'));
  h.override({});
  await wait(300);

  // Dictionary candidate search. Finds candidates in sample history (not saved)
  h.override({ history: sampleHistoryWithTerms() });
  management.open('style');
  await wait(900);
  await clickText(mw(), t('style.candidates.find'));
  await wait(300);
  await clickText(mw(), t('style.candidates.fromHistory'));
  await wait(600);
  await capture(mw(), path.join(dir, 'management-style-candidates.png'));
  await clickText(mw(), t('style.close'));
  h.override({});
  await wait(300);

  // Banner shown when accessibility permission is revoked (N13)
  h.override({ permissions: { accessibility: false } });
  management.open('history');
  await wait(800);
  await capture(mw(), path.join(dir, 'management-banner-accessibility.png'));
  h.override({});
  await wait(200);

  const fw = floater.win;
  // Sample microphone: the name macOS gives the built-in microphone in each language
  const mic = currentLocale() === 'ja' ? 'MacBook Pro のマイク' : 'MacBook Pro Microphone';
  const vars = {
    ...h.hotkeyVars(),
    mic,
    micParen: t('hud.mic.paren', { mic }),
    silenceDetail: t('hud.silence.laptop', { mic }),
  };
  const undo = [{ id: 'undo', label: t('hud.action.undo') }];
  const hud = (key: NotificationKey, extra: Record<string, string> = {}, actions?: { id: string; label: string }[]) => floater.hud(buildHud(key, { ...vars, ...extra }, actions));
  const levels = () => {
    // Quiet room noise first, then a voice
    for (let i = 0; i < 48; i++) setTimeout(() => floater.level(i < 12 ? 0.0015 : Math.abs(Math.sin(i / 2.5)) * 0.08 + 0.0015), i * 12);
  };

  // Recording (before and after the microphone is ready; F1)
  floater.setState({ phase: 'recording', mode: 'dictation', selectionChars: 0, startedAt: Date.now() - 300, visible: true, micReady: false, flash: null });
  await wait(500);
  await capture(fw, path.join(dir, 'floater-recording-mic-wait.png'));
  floater.setState({ micReady: true, micName: mic });
  levels();
  await wait(800);
  await capture(fw, path.join(dir, 'floater-recording.png'));
  hud('MicNoSignal');
  await wait(400);
  await capture(fw, path.join(dir, 'floater-recording-no-signal.png'));
  await closeAllHuds(fw);
  floater.setState({ phase: 'locked', mode: 'dictation', startedAt: Date.now() - 12000 });
  levels();
  await wait(800);
  await capture(fw, path.join(dir, 'floater-locked.png'));
  floater.setState({ phase: 'recording', mode: 'edit', selectionChars: 128 });
  await wait(500);
  await capture(fw, path.join(dir, 'floater-edit.png'));
  floater.setState({ phase: 'finalizing', mode: 'dictation', stage: 'formatting' });
  await wait(400);
  await capture(fw, path.join(dir, 'floater-finalizing.png'));

  // Notifications (N1, N2). Cards and pills, and postponing by priority
  floater.setState({ phase: 'idle', mode: 'dictation', micReady: undefined });
  hud('NoPaste');
  await wait(500);
  await capture(fw, path.join(dir, 'floater-hud-nopaste.png'));
  hud('WordsLearned', { words: 'Kubernetes' }, undo);
  await wait(400);
  // A success notification that arrives while a warning is shown is postponed, and the warning stays
  await capture(fw, path.join(dir, 'floater-hud-priority.png'));
  hud('AllSilence');
  await wait(400);
  await capture(fw, path.join(dir, 'floater-hud-allsilence.png'));
  hud('NoMicrophone');
  await wait(400);
  await capture(fw, path.join(dir, 'floater-hud-nomic-sticky.png'));
  hud('AccessibilityRevoked');
  await wait(400);
  await capture(fw, path.join(dir, 'floater-hud-accessibility.png'));
  await closeAllHuds(fw);
  hud('WordsLearnedMany', { first: 'Kubernetes', count: '2' }, undo);
  await wait(400);
  await capture(fw, path.join(dir, 'floater-hud-pill.png'));
  hud('Cancelled');
  await wait(400);
  await capture(fw, path.join(dir, 'floater-hud-cancelled.png'));
  hud('QuietMicrophone');
  await wait(400);
  await capture(fw, path.join(dir, 'floater-hud-quiet.png'));
  await closeAllHuds(fw);

  // When an edit instruction was unclear (shown inside the bar)
  hud('EditUnclear');
  await wait(150);
  await capture(fw, path.join(dir, 'floater-edit-unclear.png'));
  await wait(3300);

  // A successful paste (F5)
  floater.setState({ flash: 'pasted' });
  await wait(250);
  await capture(fw, path.join(dir, 'floater-pasted.png'));
  floater.setState({ flash: null });

  // Idle: normal, hovered, and while speech recognition is preparing (N12)
  await wait(300);
  await capture(fw, path.join(dir, 'floater-idle.png'));
  await pointer(fw, '.pill', 'mouseover');
  await wait(400);
  await capture(fw, path.join(dir, 'floater-idle-hover.png'));
  await pointer(fw, '.pill', 'mouseout');
  h.override({ status: { asr: 'loading' } });
  await wait(700);
  await capture(fw, path.join(dir, 'floater-idle-preparing.png'));
  await pointer(fw, '.pill', 'mouseover');
  await wait(400);
  await capture(fw, path.join(dir, 'floater-idle-preparing-hover.png'));
  await pointer(fw, '.pill', 'mouseout');
  h.override({});
  hud('AsrReady');
  await wait(400);
  await capture(fw, path.join(dir, 'floater-hud-asr-ready.png'));
  h.quit();
}
