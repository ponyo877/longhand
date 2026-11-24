import type { Locale } from './i18n/locale';
import type { Binding } from './protocol';

/** Key names for display, used by main and the windows alike, so that notifications show the actual shortcut */
const LABELS: Record<string, string> = {
  Fn: 'fn',
  Meta: '⌘',
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Space: 'Space',
  Escape: 'esc',
  Enter: '↩',
  Tab: '⇥',
  Backspace: '⌫',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/** Names that depend on the interface language: the left and right modifier keys and the mouse buttons */
const LOCALIZED: Record<Locale, Record<string, string>> = {
  en: {
    MetaLeft: 'Left ⌘',
    MetaRight: 'Right ⌘',
    ControlLeft: 'Left ⌃',
    ControlRight: 'Right ⌃',
    AltLeft: 'Left ⌥',
    AltRight: 'Right ⌥',
    ShiftLeft: 'Left ⇧',
    ShiftRight: 'Right ⇧',
    Mouse3: 'Middle mouse button',
    Mouse4: 'Mouse button 4',
    Mouse5: 'Mouse button 5',
  },
  ja: {
    MetaLeft: '左⌘',
    MetaRight: '右⌘',
    ControlLeft: '左⌃',
    ControlRight: '右⌃',
    AltLeft: '左⌥',
    AltRight: '右⌥',
    ShiftLeft: '左⇧',
    ShiftRight: '右⇧',
    Mouse3: 'マウス中',
    Mouse4: 'マウス4',
    Mouse5: 'マウス5',
  },
};

export const MODIFIER_ORDER = ['Fn', 'Control', 'ControlLeft', 'ControlRight', 'Alt', 'AltLeft', 'AltRight', 'Shift', 'ShiftLeft', 'ShiftRight', 'Meta', 'MetaLeft', 'MetaRight'];

export function keyLabel(k: string, locale: Locale): string {
  if (LOCALIZED[locale][k]) return LOCALIZED[locale][k];
  if (LABELS[k]) return LABELS[k];
  if (/^Key[A-Z]$/.test(k)) return k.slice(3);
  if (/^Digit\d$/.test(k)) return k.slice(5);
  return k;
}

export function sortKeys(keys: readonly string[]): string[] {
  return [...keys].sort((a, b) => {
    const ia = MODIFIER_ORDER.indexOf(a);
    const ib = MODIFIER_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

/**
 * Writes one shortcut as it appears in running text.
 * Modifier symbols are joined directly (⌃⌘V) and everything else with + (fn+Space, Right ⌥)
 */
export function bindingLabel(b: Binding | readonly string[] | undefined, locale: Locale): string {
  if (!b?.length) return '';
  const parts = sortKeys(b).map((k) => keyLabel(k, locale));
  const symbol = (s: string) => /^[⌘⌃⌥⇧]$/.test(s);
  let out = '';
  parts.forEach((p, i) => {
    if (i === 0) out = p;
    else out += symbol(parts[i - 1]) ? p : `+${p}`;
  });
  return out;
}

/** The keys of one combination that are not in another (used to explain the lock key) */
export function extraKeys(lock: readonly string[], activate: readonly string[]): string[] {
  const a = new Set(activate);
  const rest = lock.filter((k) => !a.has(k));
  return rest.length ? rest : [...lock];
}
