export const LOCALES = ['en', 'ja'] as const;
export type Locale = (typeof LOCALES)[number];
/** The setting: follow the system, or a fixed language */
export type UiLanguage = 'system' | Locale;

export const isUiLanguage = (v: unknown): v is UiLanguage => v === 'system' || (LOCALES as readonly unknown[]).includes(v);

/**
 * The language to show, from the setting and the system's preferred languages (BCP 47 tags such as "ja-JP" or "en-US"):
 * whichever of English and Japanese comes first, and English when neither is listed.
 */
export function resolveLocale(pref: UiLanguage, preferred: readonly string[]): Locale {
  if (pref !== 'system') return pref;
  for (const tag of preferred) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (base === 'en' || base === 'ja') return base;
  }
  return 'en';
}
