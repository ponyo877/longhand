import type { Binding } from './protocol';

/** キー名の表示（main と画面の両方で使う。通知の文言にも実際の割り当てを出すため） */
const LABELS: Record<string, string> = {
  Fn: 'fn',
  Meta: '⌘',
  MetaLeft: '左⌘',
  MetaRight: '右⌘',
  Control: '⌃',
  ControlLeft: '左⌃',
  ControlRight: '右⌃',
  Alt: '⌥',
  AltLeft: '左⌥',
  AltRight: '右⌥',
  Shift: '⇧',
  ShiftLeft: '左⇧',
  ShiftRight: '右⇧',
  Space: 'Space',
  Escape: 'esc',
  Enter: '↩',
  Tab: '⇥',
  Backspace: '⌫',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Mouse3: 'マウス中',
  Mouse4: 'マウス4',
  Mouse5: 'マウス5',
};

export const MODIFIER_ORDER = ['Fn', 'Control', 'ControlLeft', 'ControlRight', 'Alt', 'AltLeft', 'AltRight', 'Shift', 'ShiftLeft', 'ShiftRight', 'Meta', 'MetaLeft', 'MetaRight'];

export function keyLabel(k: string): string {
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
 * 1 つの割り当てを文の中に書く形にする。
 * 記号の修飾キーは詰めて（⌃⌘V）、それ以外は + でつなぐ（fn+Space、右⌥）
 */
export function bindingLabel(b: Binding | readonly string[] | undefined): string {
  if (!b?.length) return '';
  const parts = sortKeys(b).map(keyLabel);
  const symbol = (s: string) => /^[⌘⌃⌥⇧]$/.test(s);
  let out = '';
  parts.forEach((p, i) => {
    if (i === 0) out = p;
    else out += symbol(parts[i - 1]) ? p : `+${p}`;
  });
  return out;
}

/** あるキーの組み合わせから、別の組み合わせに含まれるキーを除いた残り（ロックキーの案内に使う） */
export function extraKeys(lock: readonly string[], activate: readonly string[]): string[] {
  const a = new Set(activate);
  const rest = lock.filter((k) => !a.has(k));
  return rest.length ? rest : [...lock];
}
