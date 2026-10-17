import { useEffect, useState } from 'react';
import { ActivityIcon, CircleAlertIcon, ExternalLinkIcon, HistoryIcon, LayoutDashboardIcon, ScrollTextIcon, type LucideIcon } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { AgentInbox } from './AgentInbox';
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
const TABS: { id: Tab; href: string; label: string; icon: LucideIcon }[] = [
  { id: 'dashboard', href: '#/', label: 'Dashboard', icon: LayoutDashboardIcon },
  { id: 'issues', href: '#/issues', label: 'Issues', icon: CircleAlertIcon },
  { id: 'rules', href: '#/rules', label: 'Rules', icon: ScrollTextIcon },
  { id: 'history', href: '#/history', label: 'Time travel', icon: HistoryIcon },
  { id: 'signals', href: '#/signals', label: 'Signals', icon: ActivityIcon },
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
      <header className="sticky top-0 z-40 bg-topbar text-topbar-foreground shadow-[0_1px_0_0_rgb(0_0_0/0.08),0_6px_16px_-10px_rgb(0_0_0/0.35)]">
        <div className="mx-auto flex h-14 max-w-[1320px] items-center gap-6 px-6">
          <a href="#/" className="group/brand flex items-center gap-2 text-[17px] font-bold text-topbar-foreground no-underline">
            <span aria-hidden="true" className="grid size-7 place-items-center rounded-md bg-topbar-active ring-1 ring-white/10">
              <span className="size-3 rounded-full border-[2.5px] border-destructive transition-transform duration-300 ease-out-expo group-hover/brand:scale-125" />
            </span>
            Churn Preventer
          </a>
          <nav aria-label="Main" className="flex items-center gap-1">
            {TABS.map((t) => (
              <a
                key={t.id}
                href={t.href}
                aria-current={tab === t.id ? 'page' : undefined}
                className="relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-topbar-muted no-underline transition-colors duration-200 hover:bg-topbar-active hover:text-topbar-foreground aria-[current=page]:bg-topbar-active aria-[current=page]:text-topbar-foreground"
              >
                <t.icon aria-hidden="true" className="size-4" />
                {t.label}
                {tab === t.id && <span aria-hidden="true" className="motion-pop absolute inset-x-3 -bottom-[9px] h-0.5 rounded-full bg-primary" />}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <a
              href={SHOP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-sm font-medium text-topbar-foreground no-underline transition-colors duration-200 hover:bg-topbar-active"
            >
              Demo shop
              <ExternalLinkIcon aria-hidden="true" className="size-3.5 text-topbar-muted" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <AgentInbox />
            </div>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-[1320px] px-6 py-6 outline-none">
        {/* Keyed by route: each page arrives with a short fade and rise; live refreshes inside a page do not replay it. */}
        <div key={route.page === 'issue' ? route.clusterId : route.page === 'replay' ? route.sessionId : route.page} className="motion-enter">
          {route.page === 'replay' ? (
            <ReplayPage key={route.sessionId} sessionId={route.sessionId} signalId={route.signalId} />
          ) : route.page === 'issue' ? (
            <IssuePage key={route.clusterId} clusterId={route.clusterId} />
          ) : route.page === 'signals' ? (
            <SignalsPage />
          ) : route.page === 'rules' ? (
            <RulesPage />
          ) : route.page === 'history' ? (
            <HistoryPage />
          ) : (
            <IssuesPage />
          )}
        </div>
      </main>
      <Toaster position="bottom-right" />
    </>
  );
}
