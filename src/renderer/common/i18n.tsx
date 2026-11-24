/**
 * Interface language in the windows. The language comes with the app snapshot (AppSnapshot.locale), so a change in settings
 * reaches every window at once.
 *
 *   const t = useT();
 *   <h1>{t('settings.title')}</h1>
 */
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { translator, type Locale, type Translate } from '../../shared/i18n';

interface I18n {
  t: Translate;
  locale: Locale;
}

const I18nContext = createContext<I18n>({ t: translator('en'), locale: 'en' });

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => ({ t: translator(locale), locale }), [locale]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Messages in the interface language */
export const useT = (): Translate => useContext(I18nContext).t;

export const useLocale = (): Locale => useContext(I18nContext).locale;

/** Locale tag for Intl and toLocale*String, so that dates and numbers follow the interface language */
export const intlLocale = (locale: Locale): string => (locale === 'ja' ? 'ja-JP' : 'en-US');
