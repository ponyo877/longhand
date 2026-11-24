import { describe, expect, it } from 'vitest';
import { buildHud, NOTIFICATIONS, recordShown, shouldShow } from './notifications';

const DAY = 24 * 3600_000;
const none = new Set<string>();

describe('shouldShow', () => {
  it('ミュートした通知は出さない', () => {
    expect(shouldShow('AllSilence', NOTIFICATIONS.AllSilence, { muted: true, count: 0, last: 0 }, 0, none)).toBe(false);
  });

  it('期間あたりの上限を守る', () => {
    const def = NOTIFICATIONS.Cancelled;
    let st = undefined;
    let now = 1_000_000_000;
    for (let i = 0; i < 3; i++) {
      expect(shouldShow('Cancelled', def, st, now, none)).toBe(true);
      st = recordShown(st, now);
      now += 1000;
    }
    expect(shouldShow('Cancelled', def, st, now, none)).toBe(false);
    // 14 日たてば、また出せる
    expect(shouldShow('Cancelled', def, st, now + 15 * DAY, none)).toBe(true);
  });

  it('生涯の上限は回数で判定する', () => {
    const def = NOTIFICATIONS.HandsFreeInfo;
    expect(shouldShow('HandsFreeInfo', def, { muted: false, count: 2, last: 1 }, 10 * DAY, none)).toBe(true);
    expect(shouldShow('HandsFreeInfo', def, { muted: false, count: 3, last: 1 }, 100 * DAY, none)).toBe(false);
  });

  it('最小の間隔を守る', () => {
    const def = NOTIFICATIONS.QuietMicrophone;
    const t0 = 1_700_000_000_000;
    const st = recordShown(undefined, t0);
    expect(shouldShow('QuietMicrophone', def, st, t0 + DAY / 2, none)).toBe(false);
    expect(shouldShow('QuietMicrophone', def, st, t0 + DAY + 1, none)).toBe(true);
  });

  it('起動ごとに 1 回の通知は 2 回目を出さない', () => {
    const def = NOTIFICATIONS.LlmNotConfigured;
    expect(shouldShow('LlmNotConfigured', def, undefined, 0, none)).toBe(true);
    expect(shouldShow('LlmNotConfigured', def, undefined, 0, new Set(['LlmNotConfigured']))).toBe(false);
  });

  it('上限のない通知は何度でも出す', () => {
    const st = { muted: false, count: 500, last: 10, times: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
    expect(shouldShow('NoPaste', NOTIFICATIONS.NoPaste, st, 11, none)).toBe(true);
  });
});

describe('buildHud', () => {
  it('決まったボタンと呼び出し側のボタンを並べ、差し込みを埋める', () => {
    const m = buildHud('NoPaste', { paste: '⌃⌘V で直前の書き起こしを貼り付けられます' }, [{ id: 'x', label: 'X' }]);
    expect(m.body).toBe('⌃⌘V で直前の書き起こしを貼り付けられます');
    expect(m.actions?.map((a) => a.id)).toEqual(['open-history', 'x']);
    expect(m.style).toBe('card');
    expect(m.mutable).toBe(false);
  });

  it('空の差し込みは取り除く', () => {
    expect(buildHud('MicNoSignal', {}).title).toBe('マイクから音が届いていません');
    expect(buildHud('MicNoSignal', { micParen: '（内蔵マイク）' }).title).toBe('マイクから音が届いていません（内蔵マイク）');
  });

  it('解決するまで消さない通知は durationMs が 0', () => {
    expect(buildHud('MicPermissionDenied').durationMs).toBe(0);
    expect(buildHud('NoMicrophone').durationMs).toBe(0);
    expect(buildHud('AccessibilityRevoked').durationMs).toBe(0);
  });
});
