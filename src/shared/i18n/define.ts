/** Values passed into a message: `{name}` in the text is replaced with vars.name */
export type Vars = Record<string, string | number>;

/** A message is text with `{name}` placeholders, or a function for text that depends on the values (English plurals, for example) */
export type Message = string | ((vars: Vars) => string);

export type Messages = Record<string, Message>;

/**
 * Declares the messages of one screen or area in both languages. TypeScript checks that the Japanese side has every key of the
 * English side. Keys start with the area's name (`settings.`, `hud.`, ...) so that areas never collide when merged.
 */
export function defineMessages<const E extends Messages>(m: { en: E; ja: { [K in keyof E]: Message } }): { en: E; ja: { [K in keyof E]: Message } } {
  return m;
}

/** Fills `{name}` placeholders. A placeholder without a value is left as it is, so that a missing value is visible */
export function format(msg: Message, vars: Vars = {}): string {
  const text = typeof msg === 'function' ? msg(vars) : msg;
  return text.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all));
}
