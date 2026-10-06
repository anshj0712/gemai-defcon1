import { useEffect, useState } from 'react';
import { IssuePage } from './IssuePage';
import { IssuesPage } from './IssuesPage';
import { ReplayPage } from './ReplayPage';
import { SignalsPage } from './SignalsPage';

type Route =
  | { page: 'issues' }
  | { page: 'issue'; clusterId: string }
  | { page: 'signals' }
  | { page: 'replay'; sessionId: string; signalId: string | null };

/** Hash routes: #/ (issues), #/issues/<id>, #/signals, #/sessions/<id>?signal=<signal_id> (replay). */
export function parseRoute(hash: string): Route {
  const replay = /^#\/sessions\/([A-Za-z0-9_-]+)(?:\?(.*))?$/.exec(hash);
  if (replay?.[1]) return { page: 'replay', sessionId: replay[1], signalId: new URLSearchParams(replay[2] ?? '').get('signal') };
  const issue = /^#\/issues\/([0-9a-f]{20})$/.exec(hash);
  if (issue?.[1]) return { page: 'issue', clusterId: issue[1] };
  if (hash === '#/signals') return { page: 'signals' };
  return { page: 'issues' };
}

export function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const tab = route.page === 'signals' ? 'signals' : 'issues';
  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">
          Churn Preventer
        </a>
        <nav className="tabs">
          <a href="#/" className={tab === 'issues' ? 'on' : ''}>
            Issues
          </a>
          <a href="#/signals" className={tab === 'signals' ? 'on' : ''}>
            Signals
          </a>
        </nav>
        <span className="synthetic">Synthetic data: demo sessions only</span>
      </header>
      <main>
        {route.page === 'replay' ? (
          <ReplayPage key={route.sessionId} sessionId={route.sessionId} signalId={route.signalId} />
        ) : route.page === 'issue' ? (
          <IssuePage key={route.clusterId} clusterId={route.clusterId} />
        ) : route.page === 'signals' ? (
          <SignalsPage />
        ) : (
          <IssuesPage />
        )}
      </main>
    </>
  );
}
