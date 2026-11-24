import { describe, expect, it } from 'vitest';
import { bindingLabel, extraKeys, keyLabel } from './keys';

describe('keys', () => {
  it('キー名を表示用にする', () => {
    expect(keyLabel('Fn')).toBe('fn');
    expect(keyLabel('KeyV')).toBe('V');
    expect(keyLabel('Digit3')).toBe('3');
    expect(keyLabel('F5')).toBe('F5');
  });

  it('記号の修飾キーは詰め、それ以外は + でつなぐ', () => {
    expect(bindingLabel(['Meta', 'Control', 'KeyV'])).toBe('⌃⌘V');
    expect(bindingLabel(['Space', 'Fn'])).toBe('fn+Space');
    expect(bindingLabel(['AltRight'])).toBe('右⌥');
    expect(bindingLabel(['ControlLeft', 'AltLeft'])).toBe('左⌃+左⌥');
    expect(bindingLabel([])).toBe('');
    expect(bindingLabel(undefined)).toBe('');
  });

  it('ロックキーから起動キーを除く', () => {
    expect(extraKeys(['Fn', 'Space'], ['Fn'])).toEqual(['Space']);
    expect(extraKeys(['F5'], ['Fn'])).toEqual(['F5']);
    expect(extraKeys(['Fn'], ['Fn'])).toEqual(['Fn']);
  });
});
