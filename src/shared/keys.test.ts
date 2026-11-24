import { describe, expect, it } from 'vitest';
import { bindingLabel, extraKeys, keyLabel } from './keys';

describe('keys', () => {
  it('names keys for display', () => {
    expect(keyLabel('Fn', 'en')).toBe('fn');
    expect(keyLabel('KeyV', 'en')).toBe('V');
    expect(keyLabel('Digit3', 'ja')).toBe('3');
    expect(keyLabel('F5', 'en')).toBe('F5');
  });

  it('names the left and right modifiers and the mouse buttons in the interface language', () => {
    expect(keyLabel('MetaRight', 'en')).toBe('Right ⌘');
    expect(keyLabel('MetaRight', 'ja')).toBe('右⌘');
    expect(keyLabel('Mouse3', 'en')).toBe('Middle mouse button');
    expect(keyLabel('Mouse3', 'ja')).toBe('マウス中');
  });

  it('joins modifier symbols directly and everything else with +', () => {
    expect(bindingLabel(['Meta', 'Control', 'KeyV'], 'en')).toBe('⌃⌘V');
    expect(bindingLabel(['Space', 'Fn'], 'en')).toBe('fn+Space');
    expect(bindingLabel(['AltRight'], 'ja')).toBe('右⌥');
    expect(bindingLabel(['ControlLeft', 'AltLeft'], 'ja')).toBe('左⌃+左⌥');
    expect(bindingLabel(['ControlLeft', 'AltLeft'], 'en')).toBe('Left ⌃+Left ⌥');
    expect(bindingLabel([], 'en')).toBe('');
    expect(bindingLabel(undefined, 'en')).toBe('');
  });

  it('removes the activation keys from the lock keys', () => {
    expect(extraKeys(['Fn', 'Space'], ['Fn'])).toEqual(['Space']);
    expect(extraKeys(['F5'], ['Fn'])).toEqual(['F5']);
    expect(extraKeys(['Fn'], ['Fn'])).toEqual(['Fn']);
  });
});
