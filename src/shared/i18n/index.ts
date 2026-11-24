/**
 * Interface language (English or Japanese).
 *
 * The interface follows the macOS language order unless the user picks a language in settings (locale.ts). Messages live in
 * messages/, one file per area, with both languages side by side; catalog.ts merges them.
 *
 * Text sent to the LLM (format/prompts.ts) is not part of the interface and stays in Japanese whatever the interface language.
 */
import { catalog } from './catalog';
import { format, type Message, type Vars } from './define';
import type { Locale } from './locale';

export { format, type Message, type Vars } from './define';

export { isUiLanguage, LOCALES, resolveLocale, type Locale, type UiLanguage } from './locale';

export type MessageKey = keyof typeof catalog.en;

export type Translate = (key: MessageKey, vars?: Vars) => string;

/** A function that returns messages in the given language */
export function translator(locale: Locale): Translate {
  const table: Record<string, Message> = catalog[locale];
  const fallback: Record<string, Message> = catalog.en;
  return (key, vars) => format(table[key] ?? fallback[key] ?? key, vars);
}

/** Every key, for tests */
export const messageKeys = (): MessageKey[] => Object.keys(catalog.en) as MessageKey[];

/** The raw message, for tests and for callers that fill placeholders themselves */
export const rawMessage = (locale: Locale, key: MessageKey): Message => catalog[locale][key];
