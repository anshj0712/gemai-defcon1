import type { Cluster, Finding, FindingSummary, ProbeDoc, ProbePreview, ProbeSource, RecordedProbeSpec, RuleAuthorMeta, RuleDoc } from '@cp/schema';
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

// ---------------------------------------------------------------------------------------------
// Phase 4: tenant rules (plain English, dry run, approve and re-scan) and time travel.
// ---------------------------------------------------------------------------------------------

/** A rule doc as the API serves it, with each version as one readable line. */
export type RuleView = RuleDoc & { text: { active: string | null; draft: string | null } };

export interface BuiltinRuleView {
  rule_id: string;
  version: number;
  title: string;
  rule_version: string;
  text: string;
}

/** An error the API explained (the agent's code and message, and the rule author's reasoning when it declined). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly author: RuleAuthorMeta | null,
  ) {
    super(message);
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string; author?: RuleAuthorMeta | null };
  if (!res.ok) throw new ApiError(json.message ?? `HTTP ${res.status}`, json.error ?? null, json.author ?? null);
  return json as T;
}

export const fetchRules = () => getJson<{ rules: RuleView[]; builtin: BuiltinRuleView[] }>('/v1/rules');
export const draftRule = (sentence: string) => postJson<{ rule: RuleDoc }>('/v1/rules/draft', { sentence });
export const approveRule = (id: string, version: number) => postJson<{ rule: RuleDoc }>(`/v1/rules/${encodeURIComponent(id)}/approve`, { version });
export const rejectRule = (id: string, note?: string) => postJson<{ rule: RuleDoc }>(`/v1/rules/${encodeURIComponent(id)}/reject`, note ? { note } : {});
export const undoRule = (id: string) => postJson<{ rule: RuleDoc }>(`/v1/rules/${encodeURIComponent(id)}/undo`, {});
export const resolveFinding = (id: string) => postJson<{ finding: Finding }>(`/v1/findings/${encodeURIComponent(id)}/resolve`, {});
export const reopenFinding = (id: string) => postJson<{ finding: Finding }>(`/v1/findings/${encodeURIComponent(id)}/reopen`, {});
export const rescanRule = (id: string) => postJson<{ rule: RuleDoc }>(`/v1/rules/${encodeURIComponent(id)}/rescan`, {});
export const redraftRule = (id: string, sentence: string) => postJson<{ rule: RuleDoc }>(`/v1/rules/${encodeURIComponent(id)}/redraft`, { sentence });
export const runWatch = () => postJson<{ results: unknown }>('/v1/watch/run', {});

// ---------------------------------------------------------------------------------------------
// Probes: numbers sessions report (declared in site code, requests, recorded from the page).
// ---------------------------------------------------------------------------------------------

export interface ProbeStatsView {
  name: string;
  source: ProbeSource;
  snapshots: number;
  values_per_snapshot: { min: number; max: number };
  min: number;
  median: number;
  max: number;
  routes: string[];
}

export interface ProbesView {
  catalog: { probes: ProbeStatsView[]; routes: string[]; currencies: string[]; sessions: number };
  registry: ProbeDoc[];
  window: { from: number; to: number };
  sessions: number;
}

export const fetchProbes = () => getJson<ProbesView>('/v1/probes');
export const previewProbe = (spec: RecordedProbeSpec) => postJson<{ preview: ProbePreview }>('/v1/probes/preview', { spec });
export const addProbe = (spec: RecordedProbeSpec) => postJson<{ probe: ProbeDoc }>('/v1/probes', { spec });
export const disableProbe = (name: string) => postJson<{ probe: ProbeDoc }>(`/v1/probes/${encodeURIComponent(name)}/disable`, {});

/** One finding version as the record held it (from the findings table, not the live feed). */
export interface HistoryFindingView {
  finding_id: string;
  version: number | null;
  title: string;
  tier: string;
  score: number | null;
  status: string | null;
  revenue_at_risk_minor: number;
  currency: string;
  revenue_status: string | null;
  affected_sessions: number;
  kind: string | null;
  route: string | null;
  valid_from: number;
  recorded_from: number;
  recorded_to: number | null;
  found_later_sessions: number;
  model_version: string | null;
}

export interface HistoryMomentView {
  at: number;
  kind: 'rule_approved' | 'rescan_done';
  rule_id: string;
  label: string;
}

export interface HistoryView {
  as_of: number;
  checked_at: number;
  window: { from: number; to: number };
  then: HistoryFindingView[];
  current: HistoryFindingView[];
  found_later: string[];
  moments: HistoryMomentView[];
}

export const fetchHistory = (asOf: number, from: number, to: number) => getJson<HistoryView>(`/v1/history?as_of=${Math.round(asOf)}&from=${Math.round(from)}&to=${Math.round(to)}`);

export interface QualityReport {
  synthetic: true;
  checked_at: number;
  sessions: number;
  seed: number;
  bugs_expected: number;
  bugs_found: number;
  lowest_recall: number;
  false_alarms: number;
  clean_sessions_flagged: number;
  jury: { reviewed: number; approved: number; held_back: number };
  bugs: { bug: string; sessions: number; issues: number; recall: number; precision: number }[];
  pass: boolean;
}
/** Null until a simulator check has run (the API answers 404). */
export const fetchQuality = () => getJson<QualityReport>('/v1/quality').catch(() => null);
