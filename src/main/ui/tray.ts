import path from 'node:path';
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import type { AudioDevice, Binding } from '../../shared/protocol';
import type { Settings } from '../../shared/settings';

export interface TrayActions {
  toggleRecording(): void;
  pasteLast(): void;
  /** 'settings/connection' のようにタブも指定できる */
  openPage(page: string): void;
  setMicrophone(id: string | null): void;
  setLanguage(lang: Settings['language']): void;
  setFloater(mode: 'show' | 'hide' | 'resume' | { snoozeMinutes: number } | 'snooze-forever'): void;
  restartHelper(): void;
  restartAsr(): void;
  quit(): void;
}

export interface TrayWarning {
  label: string;
  /** 押したときに開く管理画面のページ */
  page: string;
}

export interface TrayModel {
  recording: boolean;
  statusLine: string;
  warnings: TrayWarning[];
  settings: Settings;
  devices: AudioDevice[];
}

const ACCEL: Record<string, string> = { Meta: 'Command', Control: 'Control', Alt: 'Alt', Shift: 'Shift', Space: 'Space', Escape: 'Escape', Enter: 'Return', Tab: 'Tab' };

/** キーの割り当てをメニューの表示用のアクセラレータにする。表せないキー（fn や左右の区別）を含むときは出さない */
export function toAccelerator(b: Binding | undefined): string | undefined {
  if (!b?.length) return undefined;
  const parts: string[] = [];
  for (const k of b) {
    if (ACCEL[k]) parts.push(ACCEL[k]);
    else if (/^Key[A-Z]$/.test(k)) parts.push(k.slice(3));
    else if (/^Digit\d$/.test(k)) parts.push(k.slice(5));
    else if (/^F\d{1,2}$/.test(k)) parts.push(k);
    else return undefined;
  }
  return parts.join('+');
}

function trayIcon(recording: boolean): Electron.NativeImage {
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'tray') : path.join(app.getAppPath(), 'resources/tray');
  const img = nativeImage.createFromPath(path.join(dir, recording ? 'trayRecordingTemplate.png' : 'trayTemplate.png'));
  img.setTemplateImage(true);
  return img;
}

/** メニューバーのアイコンとメニュー（CORE-1） */
export class AppTray {
  private tray: Tray | null = null;
  private recording = false;

  constructor(private readonly actions: TrayActions) {}

  create(model: TrayModel): void {
    this.tray = new Tray(trayIcon(false));
    this.tray.setToolTip('Longhand');
    this.update(model);
  }

  update(m: TrayModel): void {
    if (!this.tray) return;
    if (m.recording !== this.recording) {
      this.recording = m.recording;
      this.tray.setImage(trayIcon(m.recording));
    }
    const a = this.actions;
    const s = m.settings;
    const snoozed = s.floaterSnoozeUntil !== null && (s.floaterSnoozeUntil === -1 || s.floaterSnoozeUntil > Date.now());
    const mics: MenuItemConstructorOptions[] = [
      { label: 'システムの既定', type: 'radio', checked: !s.microphoneId, click: () => a.setMicrophone(null) },
      ...m.devices
        .filter((d) => !d.isVirtual)
        .map<MenuItemConstructorOptions>((d) => ({
          label: d.name + (d.isDefault ? '（既定）' : ''),
          type: 'radio',
          checked: s.microphoneId === d.id,
          click: () => a.setMicrophone(d.id),
        })),
    ];
    const template: MenuItemConstructorOptions[] = [
      // 隠したバーを戻す場所を、いちばん上に出す（T1）
      ...(snoozed ? ([{ label: 'フローティングバーを表示', click: () => a.setFloater('resume') }, { type: 'separator' }] as MenuItemConstructorOptions[]) : []),
      { label: m.statusLine, enabled: false },
      ...m.warnings.map<MenuItemConstructorOptions>((w) => ({ label: `⚠︎ ${w.label}…`, click: () => a.openPage(w.page) })),
      { type: 'separator' },
      { label: m.recording ? '録音を確定する' : '録音を開始する（ハンズフリー）', click: () => a.toggleRecording() },
      { label: '直前の書き起こしを貼り付け', accelerator: toAccelerator(s.hotkeys.paste_last[0]), registerAccelerator: false, click: () => a.pasteLast() },
      { type: 'separator' },
      { label: '履歴を開く…', click: () => a.openPage('history') },
      { label: 'スタイル（辞書・置換・指示）…', click: () => a.openPage('style') },
      { type: 'separator' },
      { label: 'マイク', submenu: mics },
      {
        label: '言語',
        submenu: [
          { label: '日本語', type: 'radio', checked: s.language === 'ja', click: () => a.setLanguage('ja') },
          { label: 'English', type: 'radio', checked: s.language === 'en', click: () => a.setLanguage('en') },
          { label: '自動判定', type: 'radio', checked: s.language === 'auto', click: () => a.setLanguage('auto') },
        ],
      },
      {
        label: 'フローティングバー',
        submenu: [
          { label: '表示する', type: 'checkbox', checked: s.showFloater && !snoozed, click: () => a.setFloater(s.showFloater && !snoozed ? 'hide' : 'show') },
          { type: 'separator' },
          { label: '1 分間隠す', click: () => a.setFloater({ snoozeMinutes: 1 }) },
          { label: '15 分間隠す', click: () => a.setFloater({ snoozeMinutes: 15 }) },
          { label: '1 時間隠す', click: () => a.setFloater({ snoozeMinutes: 60 }) },
          { label: '戻すまで隠す', click: () => a.setFloater('snooze-forever') },
        ],
      },
      { type: 'separator' },
      { label: '設定…', accelerator: 'Command+,', registerAccelerator: false, click: () => a.openPage('settings') },
      {
        label: 'トラブルシューティング',
        submenu: [
          { label: 'ヘルパーを再起動', click: () => a.restartHelper() },
          { label: '音声認識を再起動', click: () => a.restartAsr() },
          { label: '初回の案内をもう一度表示', click: () => a.openPage('onboarding') },
        ],
      },
      { type: 'separator' },
      { label: 'Longhand を終了', accelerator: 'Command+Q', registerAccelerator: false, click: () => a.quit() },
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  destroy(): void {
    this.tray?.destroy();
  }
}
