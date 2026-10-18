import { useEffect, useState } from 'react';
import { ArrowUpRightIcon } from '@phosphor-icons/react';
import { buttonVariants } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
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
      <header className="sticky top-0 z-40 bg-topbar text-topbar-foreground">
        <div className="mx-auto flex max-w-[1320px] flex-wrap items-center gap-x-8 gap-y-1 px-6 py-2.5 md:h-16 md:flex-nowrap md:py-0">
          <a href="#/" className="text-[17px] font-semibold tracking-[-0.02em] whitespace-nowrap text-topbar-foreground no-underline">
            Churn Preventer
          </a>
          <nav aria-label="Main" className="order-last -mx-2 flex w-[calc(100%+1rem)] gap-1 overflow-x-auto md:order-none md:mx-0 md:w-auto">
            {TABS.map((t) => (
              <a
                key={t.id}
                href={t.href}
                aria-current={tab === t.id ? 'page' : undefined}
                className="rounded-md px-3 py-1.5 text-[14px] font-medium whitespace-nowrap text-topbar-muted no-underline transition-colors duration-200 hover:text-topbar-foreground aria-[current=page]:bg-topbar-active aria-[current=page]:text-topbar-foreground"
              >
                {t.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <ThemeToggle />
            <AgentInbox />
            <a href={SHOP_URL} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants(), 'ml-1.5 gap-1.5 no-underline')}>
              Open the shoe store
              <ArrowUpRightIcon data-icon="inline-end" aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
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
