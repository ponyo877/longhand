import { useEffect, useState } from 'react';
import type { DeepPartial } from '../../shared/types';
import type { MessageKey } from '../../shared/i18n';
import type { Settings } from '../../shared/settings';
import type { AppSnapshot } from '../../shared/types';
import { I18nProvider, useT } from '../common/i18n';
import { bindingLabel } from '../common/keys';
import { Button, cx, StatusDot, useSnapshot } from '../common/ui';
import { History } from './History';
import { Onboarding } from './Onboarding';
import { SettingsPage } from './Settings';
import { Style } from './Style';

type Page = 'history' | 'style' | 'settings' | 'onboarding';

const NAV: { id: Page; label: MessageKey; icon: string }[] = [
  { id: 'history', label: 'app.nav.history', icon: 'M3 4h10M3 8h10M3 12h6' },
  { id: 'style', label: 'app.nav.style', icon: 'M4 12l2.5-7h3L12 12M5.2 9.5h5.6' },
  { id: 'settings', label: 'app.nav.settings', icon: 'M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4' },
];

export function App() {
  const [snap, update] = useSnapshot();
  if (!snap) return null;
  return (
    <I18nProvider locale={snap.locale}>
      <Frame snap={snap} update={update} />
    </I18nProvider>
  );
}

function Frame({ snap, update }: { snap: AppSnapshot; update: (patch: DeepPartial<Settings>) => Promise<void> }) {
  const t = useT();
  const [page, setPage] = useState<Page>('history');
  const [settingsTab, setSettingsTab] = useState<string | undefined>();

  // A page can be opened down to a tab, as in 'settings/connection'
  useEffect(
    () =>
      window.longhand.onNavigate((p) => {
        const [pg, tab] = p.split('/');
        setPage(pg as Page);
        setSettingsTab(tab);
      }),
    [],
  );

  if (page === 'onboarding') {
    return <Onboarding snap={snap} update={update} onDone={() => setPage('history')} />;
  }

  const st = snap.status;
  // Each problem opens the tab where it is fixed (S5)
  const problems = [
    st.helper !== 'running' && { label: t('app.problem.helper'), tab: 'about' },
    st.asr !== 'ready' && { label: t('app.problem.asr'), tab: 'connection' },
    !snap.permissions.accessibility && { label: t('app.problem.accessibility'), tab: 'about' },
    snap.permissions.microphone === 'denied' && { label: t('app.problem.microphone'), tab: 'about' },
    !st.llmConfigured && { label: t('app.problem.llm'), tab: 'connection' },
  ].filter(Boolean) as { label: string; tab: string }[];
  const openSettings = (tab: string) => {
    setPage('settings');
    setSettingsTab(tab);
  };
  const activate = bindingLabel(snap.settings.hotkeys.activate[0], snap.locale) || 'fn';
  // Without accessibility, the banner shows on every page (N13)
  const accessibilityMissing = !snap.permissions.accessibility;
  // Different wording when permission was granted once and then removed (after the first-run setup) and when it never was
  const accessibilityLost = snap.settings.onboardingComplete;

  return (
    <div className="flex h-screen">
      <aside className="drag flex w-[200px] shrink-0 flex-col px-3 pb-3 pt-12">
        <div className="mb-4 px-2 text-[15px] font-semibold tracking-tight">Longhand</div>
        <nav className="no-drag flex flex-col gap-0.5">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setPage(n.id)}
              className={cx(
                'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px]',
                page === n.id ? 'bg-black/[0.08] font-medium dark:bg-white/[0.12]' : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
              )}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" className="opacity-70">
                <path d={n.icon} stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {t(n.label)}
            </button>
          ))}
        </nav>
        <div className="no-drag mt-auto rounded-lg px-2 py-2 text-[11.5px] text-neutral-500 dark:text-neutral-400">
          {problems.length ? (
            <button className="flex items-center gap-1.5 text-left hover:underline" onClick={() => openSettings(problems[0].tab)}>
              <StatusDot ok={false} warn /> {t('app.status.check', { items: problems.map((x) => x.label).join(t('common.listSeparator')) })}
            </button>
          ) : (
            <span className="flex items-center gap-1.5">
              <StatusDot ok /> {t('app.status.ready', { activate })}
            </span>
          )}
          <div className="mt-1 opacity-70">v{snap.version}</div>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto bg-[#f6f6f7] px-9 pb-12 pt-10 dark:bg-[#1c1c1e]">
        {accessibilityMissing && (
          <div role="alert" className="mx-auto mb-6 flex max-w-[760px] items-center gap-3 rounded-xl bg-rose-500/10 px-4 py-3 text-[13px] ring-1 ring-rose-500/30">
            <StatusDot ok={false} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t(accessibilityLost ? 'app.accessibility.lostTitle' : 'app.accessibility.neededTitle')}</div>
              <div className="mt-0.5 text-[12px] text-neutral-600 dark:text-neutral-300">{t(accessibilityLost ? 'app.accessibility.lostBody' : 'app.accessibility.neededBody')}</div>
            </div>
            <Button variant="primary" small onClick={() => void window.longhand.openExternal('accessibility')}>
              {t('common.openSystemSettings')}
            </Button>
          </div>
        )}
        <div className="mx-auto max-w-[760px]">
          {page === 'history' && <History />}
          {page === 'style' && <Style snap={snap} />}
          {page === 'settings' && <SettingsPage key={settingsTab} initialTab={settingsTab} snap={snap} update={update} openOnboarding={() => setPage('onboarding')} />}
        </div>
      </main>
    </div>
  );
}
