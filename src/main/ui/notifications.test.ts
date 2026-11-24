import { describe, expect, it } from 'vitest';
import { messageKeys } from '../../shared/i18n';
import { setUiLanguage } from '../i18n';
import { buildHud, NOTIFICATIONS, recordShown, shouldShow } from './notifications';

const DAY = 24 * 3600_000;
const none = new Set<string>();

describe('shouldShow', () => {
  it('does not show a muted notification', () => {
    expect(shouldShow('AllSilence', NOTIFICATIONS.AllSilence, { muted: true, count: 0, last: 0 }, 0, none)).toBe(false);
  });

  it('keeps to the limit per period', () => {
    const def = NOTIFICATIONS.Cancelled;
    let st = undefined;
    let now = 1_000_000_000;
    for (let i = 0; i < 3; i++) {
      expect(shouldShow('Cancelled', def, st, now, none)).toBe(true);
      st = recordShown(st, now);
      now += 1000;
    }
    expect(shouldShow('Cancelled', def, st, now, none)).toBe(false);
    // After 14 days it can be shown again
    expect(shouldShow('Cancelled', def, st, now + 15 * DAY, none)).toBe(true);
  });

  it('judges a lifetime limit by the count', () => {
    const def = NOTIFICATIONS.HandsFreeInfo;
    expect(shouldShow('HandsFreeInfo', def, { muted: false, count: 2, last: 1 }, 10 * DAY, none)).toBe(true);
    expect(shouldShow('HandsFreeInfo', def, { muted: false, count: 3, last: 1 }, 100 * DAY, none)).toBe(false);
  });

  it('keeps to the minimum interval', () => {
    const def = NOTIFICATIONS.QuietMicrophone;
    const t0 = 1_700_000_000_000;
    const st = recordShown(undefined, t0);
    expect(shouldShow('QuietMicrophone', def, st, t0 + DAY / 2, none)).toBe(false);
    expect(shouldShow('QuietMicrophone', def, st, t0 + DAY + 1, none)).toBe(true);
  });

  it('does not show a once-per-launch notification a second time', () => {
    const def = NOTIFICATIONS.LlmNotConfigured;
    expect(shouldShow('LlmNotConfigured', def, undefined, 0, none)).toBe(true);
    expect(shouldShow('LlmNotConfigured', def, undefined, 0, new Set(['LlmNotConfigured']))).toBe(false);
  });

  it('shows a notification without limits any number of times', () => {
    const st = { muted: false, count: 500, last: 10, times: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
    expect(shouldShow('NoPaste', NOTIFICATIONS.NoPaste, st, 11, none)).toBe(true);
  });
});

describe('buildHud', () => {
  it('lists the fixed buttons before the caller’s buttons and fills placeholders', () => {
    const m = buildHud('NoPaste', { paste: 'Press ⌃⌘V to paste the last transcript' }, [{ id: 'x', label: 'X' }]);
    expect(m.title).toBe('No place to type the text was found');
    expect(m.body).toBe('Press ⌃⌘V to paste the last transcript');
    expect(m.actions).toEqual([
      { id: 'open-history', label: 'Open History' },
      { id: 'x', label: 'X' },
    ]);
    expect(m.style).toBe('card');
    expect(m.mutable).toBe(false);
  });

  it('drops empty placeholders', () => {
    expect(buildHud('MicNoSignal', {}).title).toBe('No sound is coming from the microphone');
    expect(buildHud('MicNoSignal', { micParen: '(Built-in Microphone)' }).title).toBe('No sound is coming from the microphone (Built-in Microphone)');
  });

  it('leaves out the body of a notification that has none', () => {
    expect(buildHud('PastedLast').body).toBeUndefined();
    expect(buildHud('LlmFailed', {}).body).toBeUndefined();
  });

  it('uses the English plural for counts', () => {
    expect(buildHud('WordsLearnedMany', { first: 'Kubernetes', count: '3' }).title).toBe('Added 3 words to the dictionary, including “Kubernetes”');
    expect(buildHud('CorrectionsLearnedMany', { text: 'GitHub', count: '1' }).title).toBe('Learned the correction “GitHub”');
  });

  it('follows the interface language', () => {
    setUiLanguage('ja', []);
    try {
      const m = buildHud('MicNoSignal', { micParen: '（内蔵マイク）' });
      expect(m.title).toBe('マイクから音が届いていません（内蔵マイク）');
      expect(buildHud('NoPaste').actions?.[0].label).toBe('履歴を開く');
    } finally {
      setUiLanguage('en', []);
    }
  });

  it('gives 0 as durationMs to notifications that stay until resolved', () => {
    expect(buildHud('MicPermissionDenied').durationMs).toBe(0);
    expect(buildHud('NoMicrophone').durationMs).toBe(0);
    expect(buildHud('AccessibilityRevoked').durationMs).toBe(0);
  });
});

describe('notification text', () => {
  it('has a title for every notification', () => {
    const keys = new Set<string>(messageKeys());
    for (const key of Object.keys(NOTIFICATIONS)) expect(keys.has(`hud.${key}.title`), key).toBe(true);
  });

  it('has no title or body for a notification that does not exist', () => {
    for (const key of messageKeys()) {
      const m = /^hud\.([A-Z]\w*)\.(title|body)$/.exec(key);
      if (m) expect(m[1] in NOTIFICATIONS, key).toBe(true);
    }
  });
});
