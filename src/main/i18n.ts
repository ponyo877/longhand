/**
 * Interface language in the main process: menus, dialogs and notifications. main.ts sets it from the settings and the system
 * languages, and calls it again when either changes.
 */
import { resolveLocale, translator, type Locale, type MessageKey, type Translate, type UiLanguage, type Vars } from '../shared/i18n';

let locale: Locale = 'en';
let translate: Translate = translator(locale);

/** Sets the language from the setting and the system's preferred languages. Returns true when it changed */
export function setUiLanguage(pref: UiLanguage, systemLanguages: readonly string[]): boolean {
  const next = resolveLocale(pref, systemLanguages);
  if (next === locale) return false;
  locale = next;
  translate = translator(next);
  return true;
}

export const currentLocale = (): Locale => locale;

/** A message in the current interface language */
export const t = (key: MessageKey, vars?: Vars): string => translate(key, vars);
