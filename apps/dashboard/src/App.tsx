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
  { id: 'signals', href: '#/signals', label: 'Signals' },
];

const tabOf = (route: Route): Tab => (route.page === 'issue' || route.page === 'replay' ? 'issues' : route.page);

/** The mark: a revenue line that dips and recovers, in a rounded square. */
function BrandMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6 shrink-0">
      <rect x="1" y="1" width="22" height="22" rx="6" className="fill-foreground" />
      <path d="M5 8.5 9.5 14l3-3 6.5 6" fill="none" stroke="var(--background)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="9.5" cy="14" r="1.6" fill="var(--tier-p0)" />
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
      <header className="sticky top-0 z-40 border-b bg-topbar/85 text-topbar-foreground backdrop-blur-md supports-[backdrop-filter]:bg-topbar/75">
        <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-8 px-6">
          <a href="#/" className="flex items-center gap-2.5 text-topbar-foreground no-underline">
            <BrandMark />
            <span className="font-display text-[19px] leading-none font-semibold tracking-[-0.015em]">Churn Preventer</span>
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
                {tab === t.id && <span aria-hidden="true" className="motion-grow absolute inset-x-0 -bottom-px h-[2px] bg-topbar-foreground" />}
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
            <span aria-hidden="true" className="h-5 w-px bg-border" />
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
