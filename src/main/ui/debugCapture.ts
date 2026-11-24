import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { EngineStatus, HistoryItem, PermissionStatus } from '../../shared/types';
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
  /** 権限と状態を仮に変える（バナーや準備中の表示を確かめるため）。空のオブジェクトで元に戻す */
  override: (o: { permissions?: Partial<PermissionStatus>; status?: Partial<EngineStatus>; history?: HistoryItem[] }) => void;
  /** 通知の差し込み（実際のキーの割り当て） */
  hotkeyVars: () => Record<string, string>;
}

/** 画面の中の要素にホバーしたことにする（React の onMouseEnter は mouseover から作られる） */
async function pointer(win: BrowserWindow | null, selector: string, type: 'mouseover' | 'mouseout'): Promise<void> {
  await win?.webContents.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, { bubbles: true })); })()`,
  );
}

/** 履歴の画面の確認用の見本（印の出方を一通り見るためのもの） */
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

/** 辞書の候補を探す画面の確認用の見本（英字の語を含む、作った文） */
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

/** ボタンの文言で押す */
async function clickText(win: BrowserWindow | null, text: string): Promise<void> {
  await win?.webContents.executeJavaScript(`(() => { const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}); if (el) el.click(); })()`);
}

async function closeAllHuds(win: BrowserWindow | null): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await win?.webContents.executeJavaScript(`[...document.querySelectorAll('button[aria-label="閉じる"]')].forEach((b) => b.click())`);
    await wait(120);
  }
}

/**
 * 開発用。LONGHAND_DEBUG_CAPTURE=<ディレクトリ> を付けて起動すると、各画面とフローティングバーの状態を PNG に書き出して終了する。
 * 画面の確認を、ユーザーの画面全体を撮らずに行うためのもの。
 * 通知は表示回数の記録を残さないよう、main の showHud を通さずに直接出す。
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
    // 長いページは下までスクロールした状態も撮る
    const scrolled = await mw()?.webContents.executeJavaScript(
      `(() => { const el = [...document.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY !== 'visible'); if (!el) return false; el.scrollTop = el.scrollHeight; return true; })()`,
    );
    if (scrolled) {
      await wait(300);
      await capture(mw(), path.join(dir, `management-${page.replace('/', '-')}-bottom.png`));
    }
  }

  // 初回の案内の各手順（サイドバーの手順名を押す）
  for (const step of ['マイク', 'アクセシビリティ', 'キーのテスト', '試す']) {
    management.open('onboarding');
    await wait(500);
    await clickText(mw(), step);
    await wait(1200);
    await capture(mw(), path.join(dir, `onboarding-${step}.png`));
  }

  // 履歴の印と手直しの欄（G4-08）。見本の履歴を出す（保存はしない）
  h.override({ history: sampleHistory() });
  management.open('history');
  await wait(900);
  await capture(mw(), path.join(dir, 'management-history-sample.png'));
  await mw()?.webContents.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '文を直す'); if (b) b.click(); })()`);
  await wait(500);
  await capture(mw(), path.join(dir, 'management-history-edit.png'));
  h.override({});
  await wait(300);

  // 辞書の候補を探す画面。見本の履歴から候補を出す（保存はしない）
  h.override({ history: sampleHistoryWithTerms() });
  management.open('style');
  await wait(900);
  await clickText(mw(), '候補を探す');
  await wait(300);
  await clickText(mw(), 'Longhand の履歴から');
  await wait(600);
  await capture(mw(), path.join(dir, 'management-style-candidates.png'));
  await clickText(mw(), '閉じる');
  h.override({});
  await wait(300);

  // アクセシビリティの許可が外れたときのバナー（N13）
  h.override({ permissions: { accessibility: false } });
  management.open('history');
  await wait(800);
  await capture(mw(), path.join(dir, 'management-banner-accessibility.png'));
  h.override({});
  await wait(200);

  const fw = floater.win;
  const vars = {
    ...h.hotkeyVars(),
    mic: 'MacBook Pro のマイク',
    micParen: '（MacBook Pro のマイク）',
    silenceDetail: 'MacBook Pro のマイク からの音声が無音でした。ノート PC を閉じているときは、外付けのマイクを使ってください',
  };
  const hud = (key: NotificationKey, extra: Record<string, string> = {}, actions?: { id: string; label: string }[]) => floater.hud(buildHud(key, { ...vars, ...extra }, actions));
  const levels = () => {
    // 最初は静かな部屋の雑音、そのあと声
    for (let i = 0; i < 48; i++) setTimeout(() => floater.level(i < 12 ? 0.0015 : Math.abs(Math.sin(i / 2.5)) * 0.08 + 0.0015), i * 12);
  };

  // 録音中（マイクの準備前と後。F1）
  floater.setState({ phase: 'recording', mode: 'dictation', selectionChars: 0, startedAt: Date.now() - 300, visible: true, micReady: false, flash: null });
  await wait(500);
  await capture(fw, path.join(dir, 'floater-recording-mic-wait.png'));
  floater.setState({ micReady: true, micName: 'MacBook Pro のマイク' });
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

  // 通知（N1、N2）。カードとピル、優先度による後回し
  floater.setState({ phase: 'idle', mode: 'dictation', micReady: undefined });
  hud('NoPaste');
  await wait(500);
  await capture(fw, path.join(dir, 'floater-hud-nopaste.png'));
  hud('WordsLearned', { words: 'Kubernetes' }, [{ id: 'undo', label: '取り消す' }]);
  await wait(400);
  // 警告の表示中に来た成功の通知は後回しになり、警告が出たまま
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
  hud('WordsLearnedMany', { first: 'Kubernetes', count: '2' }, [{ id: 'undo', label: '取り消す' }]);
  await wait(400);
  await capture(fw, path.join(dir, 'floater-hud-pill.png'));
  hud('Cancelled');
  await wait(400);
  await capture(fw, path.join(dir, 'floater-hud-cancelled.png'));
  hud('QuietMicrophone');
  await wait(400);
  await capture(fw, path.join(dir, 'floater-hud-quiet.png'));
  await closeAllHuds(fw);

  // 編集の指示が分からなかったとき（バーの中に出す）
  hud('EditUnclear');
  await wait(150);
  await capture(fw, path.join(dir, 'floater-edit-unclear.png'));
  await wait(3300);

  // 貼り付けの成功（F5）
  floater.setState({ flash: 'pasted' });
  await wait(250);
  await capture(fw, path.join(dir, 'floater-pasted.png'));
  floater.setState({ flash: null });

  // 待機中。通常、ホバー、音声認識の準備中（N12）
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
