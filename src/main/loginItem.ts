/**
 * Registration for "Open at Login" (CORE-4).
 *
 * The app registers only when it is in an Applications folder.
 * Registering an app launched from a build output folder or the Downloads folder would start an app with no settled location
 * at the next login (even trying out a package built during development would register it).
 * Unregistering happens wherever the app is (so that an earlier registration can be removed).
 */
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { createLogger } from './log';

const log = createLogger('main');

/** Whether the executable is inside an Applications folder (/Applications or ~/Applications) */
export function inApplicationsFolder(exePath: string, home: string): boolean {
  const p = path.resolve(exePath);
  return [path.join(path.sep, 'Applications'), path.join(home, 'Applications')].some((dir) => p.startsWith(dir + path.sep));
}

export function applyLoginItem(openAtLogin: boolean): void {
  if (!app.isPackaged) return;
  if (openAtLogin && !inApplicationsFolder(app.getPath('exe'), os.homedir())) {
    log.info('Not registering "Open at Login" because the app runs from outside an Applications folder');
    return;
  }
  app.setLoginItemSettings({ openAtLogin });
}
