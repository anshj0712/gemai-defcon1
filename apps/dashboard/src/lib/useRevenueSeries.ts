import { useEffect, useState } from 'react';
import type { FindingSummary } from '@cp/schema';
import { fetchFindings, fetchTimeline, type HistoryMomentView } from '../api';
import { isResolved } from '../format';
import { buildLanes, revenueSeries, withCurrent, type Lane, type SeriesItem, type SeriesKey, type SeriesPoint } from './series';
import { keep, peek } from './swr';

export interface RevenueSeries {
  points: SeriesPoint[];
  keys: SeriesKey[];
  from: number;
  to: number;
  /** Rule approvals and finished re-scans, from the history record. */
  moments: HistoryMomentView[];
  /** Issues marked fixed (and still fixed), with when. */
  fixes: { at: number; id: string; title: string }[];
  findings: FindingSummary[];
  /** Each finding's revenue history, for trends. */
  items: SeriesItem[];
  /** Each finding's first hit, first known and fix, for the detection timeline. */
  lanes: Lane[];
}

const TTL_MS = 30_000;
const CACHE_KEY = 'revenue-series';
let cache: { at: number; promise: Promise<RevenueSeries> } | null = null;

/** The findings list and one timeline answer (two requests, in parallel), made into one series. */
async function build(): Promise<RevenueSeries> {
  const now = Date.now();
  const [{ findings }, timeline] = await Promise.all([fetchFindings(), fetchTimeline().catch(() => null)]);
  const known = new Map((timeline?.findings ?? []).map((t) => [t.finding_id, t]));
  const items: SeriesItem[] = findings.map((f) => ({
    id: f.cluster_id,
    title: f.title,
    versions: withCurrent(known.get(f.finding_id)?.versions ?? [], { at: f.updated_at, revenue_at_risk_minor: f.revenue.status === 'ok' ? f.revenue.revenue_at_risk_minor : 0 }),
    resolvedAt: isResolved(f) ? f.resolution!.resolved_at : null,
  }));
  const firsts = items.flatMap((it) => it.versions.map((v) => v.recorded_from));
  const hits = (timeline?.findings ?? []).map((t) => t.first_hit);
  const from = firsts.length ? Math.min(...firsts, ...hits) - 60_000 : now - 3_600_000;
  // A finding re-scored while we were fetching is newer than 'now': end the series there so it matches the totals.
  const to = Math.max(now, ...findings.map((f) => f.updated_at));
  const { points, keys } = revenueSeries(items, from, to);
  const fixes = findings.filter((f) => isResolved(f)).map((f) => ({ at: f.resolution!.resolved_at, id: f.cluster_id, title: f.title }));
  const lanes = buildLanes(
    findings.map((f) => {
      const t = known.get(f.finding_id);
      return {
        id: f.cluster_id,
        title: f.title,
        firstHit: t?.first_hit ?? f.first_seen,
        firstKnown: t?.first_known ?? f.updated_at,
        fixedAt: isResolved(f) ? f.resolution!.resolved_at : null,
        revenueMinor: f.revenue.status === 'ok' ? f.revenue.revenue_at_risk_minor : 0,
      };
    }),
  );
  return keep(CACHE_KEY, { points, keys, from, to, moments: timeline?.moments ?? [], fixes, findings, items, lanes });
}

/** Shared by the Dashboard and Time travel: at most one build per 30 s across pages. */
export function loadRevenueSeries(): Promise<RevenueSeries> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const promise = build();
    cache = { at: Date.now(), promise };
    promise.catch(() => {
      if (cache?.promise === promise) cache = null;
    });
  }
  return cache.promise;
}

/** Starts from the last series this tab saw, so a page that comes back shows its charts at once. */
export function useRevenueSeries(): { data: RevenueSeries | null; error: string | null } {
  const [data, setData] = useState<RevenueSeries | null>(() => peek<RevenueSeries>(CACHE_KEY) ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      loadRevenueSeries().then(
        (d) => alive && (setData(d), setError(null)),
        (e: Error) => alive && setError(e.message),
      );
    void load();
    const timer = setInterval(() => void load(), TTL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return { data, error };
}
