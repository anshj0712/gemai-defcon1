import { useEffect, useState } from 'react';
import { ArrowUpRightIcon } from '@phosphor-icons/react';
import { Toaster } from '@/components/ui/sonner';
import { AgentInbox } from './AgentInbox';
import { DashboardPage } from './DashboardPage';
import { HistoryPage } from './HistoryPage';
import { IssuePage } from './IssuePage';
import { IssuesPage } from './IssuesPage';
import { parseRoute, type Route } from './lib/route';
import { ReplayPage } from './ReplayPage';
import { RulesPage } from './RulesPage';
import { SignalsPage } from './SignalsPage';
import { ThemeToggle } from './ThemeToggle';

/** The demo shop is deployed on its own; the top bar links to it. */
const SHOP_URL = import.meta.env.VITE_CP_SHOP_URL ?? 'http://localhost:5173';

type Tab = 'dashboard' | 'issues' | 'rules' | 'history' | 'signals';
const TABS: { id: Tab; href: string; label: string }[] = [
  { id: 'dashboard', href: '#/', label: 'Dashboard' },
  { id: 'issues', href: '#/issues', label: 'Issues' },
  { id: 'rules', href: '#/rules', label: 'Rules' },
  { id: 'history', href: '#/history', label: 'Time travel' },
  { id: 'signals', href: '#/signals', label: 'Raw alerts' },
];

const tabOf = (route: Route): Tab => (route.page === 'issue' || route.page === 'replay' ? 'issues' : route.page);

/** The mark: a revenue line that dips and recovers, on the top bar's raised navy. */
function BrandMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 28 28" className="size-7 shrink-0">
      <rect x="0.5" y="0.5" width="27" height="27" rx="6.5" fill="var(--topbar-active)" stroke="rgb(255 255 255 / 0.1)" />
      <path d="M6.5 10 11 15.5l3-3 7.5 7" fill="none" stroke="var(--topbar-foreground)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="11" cy="15.5" r="2" fill="var(--destructive)" />
    </svg>
  );
}

export function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const tab = tabOf(route);
  return (
    <>
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 bg-topbar text-topbar-foreground shadow-[0_1px_0_0_rgb(0_0_0/0.08),0_6px_16px_-10px_rgb(0_0_0/0.35)]">
        <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-8 px-6">
          <a href="#/" className="flex items-center gap-2.5 text-topbar-foreground no-underline">
            <BrandMark />
            <span className="text-[16px] leading-none font-semibold tracking-[-0.01em]">Churn Preventer</span>
          </a>
          <nav aria-label="Main" className="flex h-full items-stretch gap-6">
            {TABS.map((t) => (
              <a
                key={t.id}
                href={t.href}
                aria-current={tab === t.id ? 'page' : undefined}
                className="relative flex items-center text-[13.5px] font-medium text-topbar-muted no-underline transition-colors duration-200 hover:text-topbar-foreground aria-[current=page]:text-topbar-foreground"
              >
                {t.label}
                {tab === t.id && <span aria-hidden="true" className="motion-grow absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-primary" />}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <a
              href={SHOP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group/shop flex items-center gap-1 text-[13.5px] font-medium text-topbar-foreground no-underline"
            >
              Demo shop
              <ArrowUpRightIcon aria-hidden="true" className="size-3.5 text-topbar-muted transition-transform duration-200 ease-out-expo group-hover/shop:translate-x-0.5 group-hover/shop:-translate-y-0.5" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <span aria-hidden="true" className="h-5 w-px bg-white/15" />
            <div className="flex items-center gap-0.5">
              <ThemeToggle />
              <AgentInbox />
            </div>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-[1320px] px-6 pt-8 pb-16 outline-none">
        {/* Keyed by route: each page arrives with a short fade and rise; live refreshes inside a page do not replay it. */}
        <div key={route.page === 'issue' ? route.clusterId : route.page === 'replay' ? route.sessionId : route.page} className="motion-enter">
          {route.page === 'replay' ? (
            <ReplayPage key={route.sessionId} sessionId={route.sessionId} signalId={route.signalId} />
          ) : route.page === 'issue' ? (
            <IssuePage key={route.clusterId} clusterId={route.clusterId} />
          ) : route.page === 'signals' ? (
            <SignalsPage />
          ) : route.page === 'rules' ? (
            <RulesPage tab={route.tab} />
          ) : route.page === 'history' ? (
            <HistoryPage />
          ) : route.page === 'issues' ? (
            <IssuesPage />
          ) : (
            <DashboardPage />
          )}
        </div>
      </main>
      <Toaster position="bottom-right" />
    </>
  );
}
