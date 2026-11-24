import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from './settings';

describe('mergeSettings', () => {
  it('ダブルタップの旧来の既定値（離してから 350ms）を新しい既定値に移す', () => {
    const s = mergeSettings({ doubleTapMs: 350 });
    expect(s.doubleTapMs).toBe(DEFAULT_SETTINGS.doubleTapMs);
    expect(s.doubleTapMeasure).toBe('press');
  });

  it('移した後と、利用者が選んだ値はそのまま', () => {
    expect(mergeSettings({ doubleTapMs: 350, doubleTapMeasure: 'press' }).doubleTapMs).toBe(350);
    expect(mergeSettings({ doubleTapMs: 500 }).doubleTapMs).toBe(500);
    expect(mergeSettings({}).doubleTapMs).toBe(DEFAULT_SETTINGS.doubleTapMs);
  });

  it('新しい項目を既定値で補う', () => {
    expect(mergeSettings({}).chromiumEnhancedUI).toBe(true);
  });

  it('自動修正（textFix）がなかった頃の設定には、規則ごとの既定値を当て、利用者が変えた値と止めた箇所は残す', () => {
    // textFix ができる前に保存された設定（defaultsRev も最新）
    const before = mergeSettings({ defaultsRev: 3, llmFastPath: true, language: 'ja' });
    expect(before.textFix).toEqual({ enabled: true, latin: true, fillers: false, notation: false, particles: true, blocked: [] });
    expect(before.llmFastPath).toBe(true);
    // 一部だけ保存されていても、残りは既定値で補う
    const partial = mergeSettings({ textFix: { latin: false, blocked: ['latin:スラック'] } });
    expect(partial.textFix).toMatchObject({ enabled: true, latin: false, particles: true, blocked: ['latin:スラック'] });
    // 既定値の配列を、利用者の設定と共有しない
    expect(mergeSettings({}).textFix.blocked).not.toBe(DEFAULT_SETTINGS.textFix.blocked);
  });

  it('既定値を変えた項目は、保存済みの設定にも 1 回だけ新しい既定値を当てる', () => {
    // 古い既定値のまま保存されていた設定
    const old = mergeSettings({ llmFastPath: true, asr: { speculative: true } });
    expect(old.llmFastPath).toBe(false);
    expect(old.asr.speculative).toBe(false);
    expect(old.defaultsRev).toBe(3);
    // 当てた後に利用者が変えた値は、そのまま残る
    const changed = mergeSettings({ ...old, llmFastPath: true, asr: { ...old.asr, speculative: true } });
    expect(changed.llmFastPath).toBe(true);
    expect(changed.asr.speculative).toBe(true);
    // 1 つ前の版で保存された設定には、その後に変えた既定値だけを当てる（近道はオフに戻し、先回りは利用者の値のまま）
    const rev2 = mergeSettings({ defaultsRev: 2, llmFastPath: true, asr: { speculative: true } });
    expect(rev2.llmFastPath).toBe(false);
    expect(rev2.asr.speculative).toBe(true);
    expect(rev2.defaultsRev).toBe(3);
  });
});
