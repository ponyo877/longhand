import { MODIFIER_ORDER } from '../../shared/keys';

export { bindingLabel, keyLabel, sortKeys } from '../../shared/keys';

const MODIFIERS = new Set(MODIFIER_ORDER);

/** 文字キーだけの組み合わせ（修飾キーなし）は、普段の入力とぶつかるので警告する */
export function isRiskyBinding(keys: string[]): boolean {
  if (keys.some((k) => MODIFIERS.has(k) || k.startsWith('Mouse') || /^F\d+$/.test(k))) return false;
  return true;
}
