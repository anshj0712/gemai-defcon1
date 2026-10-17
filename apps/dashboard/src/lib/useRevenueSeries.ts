import { useEffect, useState } from 'react';
import type { FindingSummary } from '@cp/schema';
import { fetchFinding, fetchFindings, fetchHistory, type HistoryMomentView } from '../api';
import { isResolved } from '../format';
import { revenueSeries, type SeriesItem, type SeriesKey, type SeriesPoint } from './series';

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
}

const TTL_MS = 30_000;
let cache: { at: number; promise: Promise<RevenueSeries> } | null = null;

/** The findings list, every finding's versions (in parallel), and the history moments, made into one series. */
async function build(): Promise<RevenueSeries> {
  const now = Date.now();
  const { findings } = await fetchFindings();
  const details = await Promise.all(findings.map((f) => fetchFinding(f.cluster_id).catch(() => null)));
  const items: SeriesItem[] = findings.map((f, i) => ({
    id: f.cluster_id,
    title: f.title,
    versions: details[i]?.versions ?? [],
    resolvedAt: isResolved(f) ? f.resolution!.resolved_at : null,
  }));
  const firsts = items.flatMap((it) => it.versions.map((v) => v.recorded_from));
  const from = firsts.length ? Math.min(...firsts) - 60_000 : now - 3_600_000;
  const history = await fetchHistory(now, from, now).catch(() => null);
  const { points, keys } = revenueSeries(items, from, now);
  const fixes = findings.filter((f) => isResolved(f)).map((f) => ({ at: f.resolution!.resolved_at, id: f.cluster_id, title: f.title }));
  return { points, keys, from, to: now, moments: history?.moments ?? [], fixes, findings };
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

export function useRevenueSeries(): { data: RevenueSeries | null; error: string | null } {
  const [data, setData] = useState<RevenueSeries | null>(null);
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
