/**
 * 「ログイン時に起動」の登録（CORE-4）。
 *
 * 登録するのは、アプリをアプリケーションのフォルダに置いたときだけにする。
 * ビルドの出力フォルダやダウンロードのフォルダから起動したアプリを登録すると、次のログインで、
 * 置き場所の定まらないアプリが起動してしまう（開発中に作ったパッケージを試しに起動しただけでも登録される）。
 * 登録を外すほうは、どこに置いてあっても行う（前に登録したものを外せるようにするため）。
 */
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { createLogger } from './log';

const log = createLogger('main');

/** 実行ファイルが、アプリケーションのフォルダ（/Applications か ~/Applications）の中にあるか */
export function inApplicationsFolder(exePath: string, home: string): boolean {
  const p = path.resolve(exePath);
  return [path.join(path.sep, 'Applications'), path.join(home, 'Applications')].some((dir) => p.startsWith(dir + path.sep));
}

export function applyLoginItem(openAtLogin: boolean): void {
  if (!app.isPackaged) return;
  if (openAtLogin && !inApplicationsFolder(app.getPath('exe'), os.homedir())) {
    log.info('アプリケーションのフォルダの外から起動しているので、「ログイン時に起動」は登録しません');
    return;
  }
  app.setLoginItemSettings({ openAtLogin });
}
