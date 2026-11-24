/**
 * How the user prefers to write numbers, learned from their corrections (main/format/numberStyle.ts applies them).
 * Each kind is a choice between ways of writing the same value.
 */
export const NUMBER_STYLE_KINDS = ['width', 'grouping', 'units', 'counters', 'percent', 'time', 'date'] as const;

export type NumberStyleKind = (typeof NUMBER_STYLE_KINDS)[number];

export const NUMBER_STYLE_VALUES = {
  /** Digit width: 10 or １０ */
  width: ['half', 'full'],
  /** Thousands separators in amounts and quantities: 10,000円 or 10000円 */
  grouping: ['comma', 'none'],
  /** Round amounts: 1万円 or 10000円 */
  units: ['kanji', 'digits'],
  /** Native counters: 二つ, 一人 or 2つ, 1人 */
  counters: ['kanji', 'digits'],
  /** 3% or 3パーセント (the width of the sign follows the width preference) */
  percent: ['symbol', 'word'],
  /** 10:30 or 10時30分 */
  time: ['colon', 'kanji'],
  /** 11/24 or 11月24日 */
  date: ['slash', 'kanji'],
} as const satisfies Record<NumberStyleKind, readonly string[]>;

export type NumberStyleValue<K extends NumberStyleKind = NumberStyleKind> = (typeof NUMBER_STYLE_VALUES)[K][number];

export interface NumberStylePreference {
  value: string;
  /** How many corrections in a row asked for this value */
  count: number;
  /** When it was last learned */
  at: number;
  /** The last correction it was learned from, limited to the number itself (for the Style page) */
  example?: { before: string; after: string };
}

export type NumberStyles = Partial<Record<NumberStyleKind, NumberStylePreference>>;

export function isNumberStyleKind(kind: unknown): kind is NumberStyleKind {
  return typeof kind === 'string' && (NUMBER_STYLE_KINDS as readonly string[]).includes(kind);
}

export function isNumberStyleValue(kind: NumberStyleKind, value: unknown): boolean {
  return typeof value === 'string' && (NUMBER_STYLE_VALUES[kind] as readonly string[]).includes(value);
}
