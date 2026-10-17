export type Route =
  | { page: 'issues' }
  | { page: 'issue'; clusterId: string }
  | { page: 'signals' }
  | { page: 'rules' }
  | { page: 'history' }
  | { page: 'replay'; sessionId: string; signalId: string | null };

/** Hash routes: #/ (issues), #/issues/<id>, #/signals, #/rules, #/history (time travel), #/sessions/<id>?signal=<signal_id> (replay). */
export function parseRoute(hash: string): Route {
  const replay = /^#\/sessions\/([A-Za-z0-9_-]+)(?:\?(.*))?$/.exec(hash);
  if (replay?.[1]) return { page: 'replay', sessionId: replay[1], signalId: new URLSearchParams(replay[2] ?? '').get('signal') };
  const issue = /^#\/issues\/([0-9a-f]{20})$/.exec(hash);
  if (issue?.[1]) return { page: 'issue', clusterId: issue[1] };
  if (hash === '#/signals') return { page: 'signals' };
  if (hash === '#/rules') return { page: 'rules' };
  if (hash === '#/history') return { page: 'history' };
  return { page: 'issues' };
}
