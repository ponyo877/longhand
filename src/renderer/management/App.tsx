import { useEffect, useState } from 'react';
import { bindingLabel } from '../common/keys';
import { Button, cx, StatusDot, useSnapshot } from '../common/ui';
import { History } from './History';
import { Onboarding } from './Onboarding';
import { SettingsPage } from './Settings';
import { Style } from './Style';

type Page = 'history' | 'style' | 'settings' | 'onboarding';

const NAV: { id: Page; label: string; icon: string }[] = [
  { id: 'history', label: '履歴', icon: 'M3 4h10M3 8h10M3 12h6' },
  { id: 'style', label: 'スタイル', icon: 'M4 12l2.5-7h3L12 12M5.2 9.5h5.6' },
  { id: 'settings', label: '設定', icon: 'M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4' },
];

export function App() {
  const [snap, update] = useSnapshot();
  const [page, setPage] = useState<Page>('history');
  const [settingsTab, setSettingsTab] = useState<string | undefined>();

  // 'settings/connection' のように、タブまで指定して開ける
  useEffect(
    () =>
      window.longhand.onNavigate((p) => {
        const [pg, tab] = p.split('/');
        setPage(pg as Page);
        setSettingsTab(tab);
      }),
    [],
  );

  if (!snap) return null;

  if (page === 'onboarding') {
    return <Onboarding snap={snap} update={update} onDone={() => setPage('history')} />;
  }

  const st = snap.status;
  // 問題ごとに、直す場所のタブを開く（S5）
  const problems = [
    st.helper !== 'running' && { label: 'ヘルパー', tab: 'about' },
    st.asr !== 'ready' && { label: '音声認識', tab: 'connection' },
    !snap.permissions.accessibility && { label: 'アクセシビリティ', tab: 'about' },
    snap.permissions.microphone === 'denied' && { label: 'マイク', tab: 'about' },
    !st.llmConfigured && { label: 'LLM', tab: 'connection' },
  ].filter(Boolean) as { label: string; tab: string }[];
  const openSettings = (tab: string) => {
    setPage('settings');
    setSettingsTab(tab);
  };
  const activate = bindingLabel(snap.settings.hotkeys.activate[0]) || 'fn';
  // アクセシビリティがないときは、どのページでも上に出す（N13）
  const accessibilityMissing = !snap.permissions.accessibility;
  // 一度許可してから外れた場合（初回の案内を終えた後）と、まだ許可していない場合で文言を変える
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
              {n.label}
            </button>
          ))}
        </nav>
        <div className="no-drag mt-auto rounded-lg px-2 py-2 text-[11.5px] text-neutral-500 dark:text-neutral-400">
          {problems.length ? (
            <button className="flex items-center gap-1.5 text-left hover:underline" onClick={() => openSettings(problems[0].tab)}>
              <StatusDot ok={false} warn /> {problems.map((x) => x.label).join('、')}を確認
            </button>
          ) : (
            <span className="flex items-center gap-1.5">
              <StatusDot ok /> 準備完了 · {activate} で話す
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
              <div className="font-medium">{accessibilityLost ? 'アクセシビリティの許可が外れました' : 'アクセシビリティの許可が必要です'}</div>
              <div className="mt-0.5 text-[12px] text-neutral-600 dark:text-neutral-300">
                キーの検出と入力ができません。システム設定の「プライバシーとセキュリティ」で、Longhand（開発中は Electron）をオンに{accessibilityLost ? 'し直して' : 'して'}
                ください。オンにすると自動で使えるようになります。
              </div>
            </div>
            <Button variant="primary" small onClick={() => void window.longhand.openExternal('accessibility')}>
              システム設定を開く
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
