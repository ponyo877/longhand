import { MODIFIER_ORDER } from '../../shared/keys';

export { bindingLabel, keyLabel, sortKeys } from '../../shared/keys';

const MODIFIERS = new Set(MODIFIER_ORDER);

/** Combinations of character keys only (no modifier keys) conflict with normal typing, so they get a warning */
export function isRiskyBinding(keys: string[]): boolean {
  if (keys.some((k) => MODIFIERS.has(k) || k.startsWith('Mouse') || /^F\d+$/.test(k))) return false;
  return true;
}
