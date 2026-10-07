import type { Cluster, Finding, FindingSummary } from '@cp/schema';
import type { Marker, TimedEvent } from './markers';

/** An issue in the live feed (the session list is only on the detail endpoint). */
export type ClusterSummary = Omit<Cluster, 'sessions'>;

export interface SignalRowView {
  signal_id: string;
  tenant_id: string;
  session_id: string;
  seq: number;
  detector: string;
  detector_version: string;
  route: string;
  element_selector: string | null;
  release: string;
  fingerprint: string;
  event_time: number;
  ingest_time: number;
}

export interface ReplayResponse {
  session: { session_id: string; tenant_id: string; chunks: number; release: string; route: string; started_at: number; ended_at: number };
  events: (TimedEvent & Record<string, unknown>)[];
  markers: Marker[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 404 ? 'Not found' : `HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const fetchSignals = () => getJson<{ tenant: string; signals: SignalRowView[] }>('/v1/signals?limit=200');
export const fetchReplay = (sessionId: string) => getJson<ReplayResponse>(`/v1/sessions/${encodeURIComponent(sessionId)}/replay`);
export const fetchClusters = () => getJson<{ tenant: string; clusters: ClusterSummary[] }>('/v1/clusters?limit=100');
export const fetchCluster = (id: string) => getJson<{ cluster: Cluster }>(`/v1/clusters/${encodeURIComponent(id)}`);

/** One stored version of a finding (bitemporal history from the findings table). */
export interface FindingVersionView {
  version: number | null;
  recorded_from: number;
  recorded_to: number | null;
  tier: string;
  status: string | null;
  score: number | null;
  revenue_at_risk_minor: number;
  currency: string;
  affected_sessions: number;
  title: string | null;
  model_version: string | null;
  prompt_hash: string | null;
  rule_version: string;
}

export const fetchFindings = () => getJson<{ tenant: string; findings: FindingSummary[] }>('/v1/findings?limit=200');

/** null when the agent has not scored this issue yet. */
export const fetchFinding = (id: string) =>
  getJson<{ finding: Finding; versions: FindingVersionView[] }>(`/v1/findings/${encodeURIComponent(id)}`).catch((e: Error) => {
    if (e.message === 'Not found') return null;
    throw e;
  });

export const screenshotUrl = (id: string, capturedAt: number) => `/v1/findings/${encodeURIComponent(id)}/screenshot?v=${capturedAt}`;
