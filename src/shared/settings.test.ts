import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from './settings';

describe('mergeSettings', () => {
  it('moves the old double-tap default (350ms from release) to the new default', () => {
    const s = mergeSettings({ doubleTapMs: 350 });
    expect(s.doubleTapMs).toBe(DEFAULT_SETTINGS.doubleTapMs);
    expect(s.doubleTapMeasure).toBe('press');
  });

  it('keeps values after the move and values the user chose', () => {
    expect(mergeSettings({ doubleTapMs: 350, doubleTapMeasure: 'press' }).doubleTapMs).toBe(350);
    expect(mergeSettings({ doubleTapMs: 500 }).doubleTapMs).toBe(500);
    expect(mergeSettings({}).doubleTapMs).toBe(DEFAULT_SETTINGS.doubleTapMs);
  });

  it('fills new fields with defaults', () => {
    expect(mergeSettings({}).chromiumEnhancedUI).toBe(true);
  });

  it('applies per-rule defaults to settings from before automatic fixes (textFix), keeping values the user changed and blocked spots', () => {
    // Settings saved before textFix existed (defaultsRev is already the latest)
    const before = mergeSettings({ defaultsRev: 3, llmFastPath: true, language: 'ja' });
    expect(before.textFix).toEqual({ enabled: true, latin: true, fillers: false, notation: false, particles: true, blocked: [] });
    expect(before.llmFastPath).toBe(true);
    // Even if only part is saved, the rest is filled with defaults
    const partial = mergeSettings({ textFix: { latin: false, blocked: ['latin:スラック'] } });
    expect(partial.textFix).toMatchObject({ enabled: true, latin: false, particles: true, blocked: ['latin:スラック'] });
    // The default array is not shared with the user's settings
    expect(mergeSettings({}).textFix.blocked).not.toBe(DEFAULT_SETTINGS.textFix.blocked);
  });

  it('applies a changed default once to saved settings', () => {
    // Settings saved with the old defaults
    const old = mergeSettings({ llmFastPath: true, asr: { speculative: true } });
    expect(old.llmFastPath).toBe(false);
    expect(old.asr.speculative).toBe(false);
    expect(old.defaultsRev).toBe(3);
    // Values the user changes afterwards stay as they are
    const changed = mergeSettings({ ...old, llmFastPath: true, asr: { ...old.asr, speculative: true } });
    expect(changed.llmFastPath).toBe(true);
    expect(changed.asr.speculative).toBe(true);
    // Settings saved with the previous version get only the defaults changed after it (the shortcut goes back off, running ahead keeps the user's value)
    const rev2 = mergeSettings({ defaultsRev: 2, llmFastPath: true, asr: { speculative: true } });
    expect(rev2.llmFastPath).toBe(false);
    expect(rev2.asr.speculative).toBe(true);
    expect(rev2.defaultsRev).toBe(3);
  });
});
