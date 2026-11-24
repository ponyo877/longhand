import path from 'node:path';
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import type { AudioDevice, Binding } from '../../shared/protocol';
import type { Settings } from '../../shared/settings';
import { t } from '../i18n';

export interface TrayActions {
  toggleRecording(): void;
  pasteLast(): void;
  /** A tab can be given too, as in 'settings/connection' */
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
  /** Page of the management window to open when it is clicked */
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

/** Turns a key binding into an accelerator shown in the menu. None when it has a key that cannot be shown (fn, or left and right sides) */
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

/** Menu bar icon and menu (CORE-1). The menu is rebuilt on every update, so it follows the interface language */
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
      { label: t('tray.menu.systemDefault'), type: 'radio', checked: !s.microphoneId, click: () => a.setMicrophone(null) },
      ...m.devices
        .filter((d) => !d.isVirtual)
        .map<MenuItemConstructorOptions>((d) => ({
          label: d.isDefault ? t('tray.menu.defaultMic', { name: d.name }) : d.name,
          type: 'radio',
          checked: s.microphoneId === d.id,
          click: () => a.setMicrophone(d.id),
        })),
    ];
    const template: MenuItemConstructorOptions[] = [
      // The way to bring back a hidden bar goes at the very top (T1)
      ...(snoozed ? ([{ label: t('tray.menu.showFloater'), click: () => a.setFloater('resume') }, { type: 'separator' }] as MenuItemConstructorOptions[]) : []),
      { label: m.statusLine, enabled: false },
      ...m.warnings.map<MenuItemConstructorOptions>((w) => ({ label: `⚠︎ ${w.label}…`, click: () => a.openPage(w.page) })),
      { type: 'separator' },
      { label: m.recording ? t('tray.menu.finishRecording') : t('tray.menu.startRecording'), click: () => a.toggleRecording() },
      { label: t('tray.menu.pasteLast'), accelerator: toAccelerator(s.hotkeys.paste_last[0]), registerAccelerator: false, click: () => a.pasteLast() },
      { type: 'separator' },
      { label: t('tray.menu.openHistory'), click: () => a.openPage('history') },
      { label: t('tray.menu.openStyle'), click: () => a.openPage('style') },
      { type: 'separator' },
      { label: t('tray.menu.microphone'), submenu: mics },
      {
        label: t('tray.menu.language'),
        submenu: [
          { label: t('tray.language.ja'), type: 'radio', checked: s.language === 'ja', click: () => a.setLanguage('ja') },
          { label: t('tray.language.en'), type: 'radio', checked: s.language === 'en', click: () => a.setLanguage('en') },
          { label: t('tray.language.auto'), type: 'radio', checked: s.language === 'auto', click: () => a.setLanguage('auto') },
        ],
      },
      {
        label: t('tray.menu.floater'),
        submenu: [
          { label: t('tray.menu.floaterVisible'), type: 'checkbox', checked: s.showFloater && !snoozed, click: () => a.setFloater(s.showFloater && !snoozed ? 'hide' : 'show') },
          { type: 'separator' },
          { label: t('tray.menu.hideMinutes', { minutes: 1 }), click: () => a.setFloater({ snoozeMinutes: 1 }) },
          { label: t('tray.menu.hideMinutes', { minutes: 15 }), click: () => a.setFloater({ snoozeMinutes: 15 }) },
          { label: t('tray.menu.hideHour'), click: () => a.setFloater({ snoozeMinutes: 60 }) },
          { label: t('tray.menu.hideUntilShown'), click: () => a.setFloater('snooze-forever') },
        ],
      },
      { type: 'separator' },
      { label: t('tray.menu.settings'), accelerator: 'Command+,', registerAccelerator: false, click: () => a.openPage('settings') },
      {
        label: t('tray.menu.troubleshooting'),
        submenu: [
          { label: t('tray.menu.restartHelper'), click: () => a.restartHelper() },
          { label: t('tray.menu.restartAsr'), click: () => a.restartAsr() },
          { label: t('tray.menu.showOnboarding'), click: () => a.openPage('onboarding') },
        ],
      },
      { type: 'separator' },
      { label: t('tray.menu.quit'), accelerator: 'Command+Q', registerAccelerator: false, click: () => a.quit() },
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  destroy(): void {
    this.tray?.destroy();
  }
}
