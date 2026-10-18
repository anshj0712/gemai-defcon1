/** Rules sub-tabs; absent means "Waiting for approval". */
export type RulesTab = 'live' | 'probes';

export type Route =
  | { page: 'dashboard' }
  | { page: 'issues' }
  | { page: 'issue'; clusterId: string }
  | { page: 'signals' }
  | { page: 'rules'; tab?: RulesTab }
  | { page: 'history' }
  | { page: 'replay'; sessionId: string; signalId: string | null };

/**
 * Hash routes: #/ (dashboard), #/issues, #/issues/<id>, #/signals, #/rules (waiting for approval), #/rules/live,
 * #/rules/probes, #/history (time travel), #/sessions/<id>?signal=<signal_id> (replay). Anything else is the dashboard.
 */
export function parseRoute(hash: string): Route {
  const replay = /^#\/sessions\/([A-Za-z0-9_-]+)(?:\?(.*))?$/.exec(hash);
  if (replay?.[1]) return { page: 'replay', sessionId: replay[1], signalId: new URLSearchParams(replay[2] ?? '').get('signal') };
  const issue = /^#\/issues\/([0-9a-f]{20})$/.exec(hash);
  if (issue?.[1]) return { page: 'issue', clusterId: issue[1] };
  if (hash === '#/issues' || hash.startsWith('#/issues/')) return { page: 'issues' };
  if (hash === '#/signals') return { page: 'signals' };
  if (hash === '#/rules') return { page: 'rules' };
  if (hash === '#/rules/live' || hash === '#/rules/probes') return { page: 'rules', tab: hash.slice('#/rules/'.length) as RulesTab };
  if (hash === '#/history') return { page: 'history' };
  return { page: 'dashboard' };
}
