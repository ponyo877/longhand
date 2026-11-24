import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '', setLoginItemSettings: vi.fn() } }));

import { inApplicationsFolder } from './loginItem';

describe('inApplicationsFolder', () => {
  const home = '/Users/someone';

  it('returns true inside an Applications folder', () => {
    expect(inApplicationsFolder('/Applications/Longhand.app/Contents/MacOS/Longhand', home)).toBe(true);
    expect(inApplicationsFolder('/Users/someone/Applications/Longhand.app/Contents/MacOS/Longhand', home)).toBe(true);
    expect(inApplicationsFolder('/Applications/Tools/Longhand.app/Contents/MacOS/Longhand', home)).toBe(true);
  });

  it('returns false for a build output folder or the Downloads folder', () => {
    expect(inApplicationsFolder('/Users/someone/work/longhand/out/Longhand-darwin-arm64/Longhand.app/Contents/MacOS/Longhand', home)).toBe(false);
    expect(inApplicationsFolder('/Users/someone/Downloads/Longhand.app/Contents/MacOS/Longhand', home)).toBe(false);
    expect(inApplicationsFolder('/private/var/folders/xx/AppTranslocation/1234/d/Longhand.app/Contents/MacOS/Longhand', home)).toBe(false);
  });

  it('returns false for folders whose names only look similar', () => {
    expect(inApplicationsFolder('/Applications2/Longhand.app/Contents/MacOS/Longhand', home)).toBe(false);
    expect(inApplicationsFolder('/Users/someone/ApplicationsOld/Longhand.app/Contents/MacOS/Longhand', home)).toBe(false);
  });
});
