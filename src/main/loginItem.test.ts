import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '', setLoginItemSettings: vi.fn() } }));

import { inApplicationsFolder } from './loginItem';

describe('inApplicationsFolder', () => {
  const home = '/Users/someone';

  it('アプリケーションのフォルダの中なら true', () => {
    expect(inApplicationsFolder('/Applications/Longhand.app/Contents/MacOS/Longhand', home)).toBe(true);
    expect(inApplicationsFolder('/Users/someone/Applications/Longhand.app/Contents/MacOS/Longhand', home)).toBe(true);
    expect(inApplicationsFolder('/Applications/Tools/Longhand.app/Contents/MacOS/Longhand', home)).toBe(true);
  });

  it('ビルドの出力フォルダやダウンロードのフォルダなら false', () => {
    expect(inApplicationsFolder('/Users/someone/work/longhand/out/Longhand-darwin-arm64/Longhand.app/Contents/MacOS/Longhand', home)).toBe(false);
    expect(inApplicationsFolder('/Users/someone/Downloads/Longhand.app/Contents/MacOS/Longhand', home)).toBe(false);
    expect(inApplicationsFolder('/private/var/folders/xx/AppTranslocation/1234/d/Longhand.app/Contents/MacOS/Longhand', home)).toBe(false);
  });

  it('名前が似ているだけのフォルダは false', () => {
    expect(inApplicationsFolder('/Applications2/Longhand.app/Contents/MacOS/Longhand', home)).toBe(false);
    expect(inApplicationsFolder('/Users/someone/ApplicationsOld/Longhand.app/Contents/MacOS/Longhand', home)).toBe(false);
  });
});
