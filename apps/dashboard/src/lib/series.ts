/**
 * Revenue at risk over time, from the findings record (bitemporal: each finding version holds the revenue the
 * system believed from `recorded_from` until `recorded_to`). A finding marked fixed counts as zero from the moment
 * it was fixed while it stays fixed, so the line falls after fixes. Pure: the caller fetches the versions.
 */

export interface SeriesVersion {
  recorded_from: number;
  recorded_to: number | null;
  revenue_at_risk_minor: number;
}

export interface SeriesItem {
  id: string;
  title: string;
  versions: readonly SeriesVersion[];
  /** When it was marked fixed, if it is fixed now. */
  resolvedAt: number | null;
}

export interface SeriesKey {
  key: string;
  label: string;
  /** The finding behind the key, or null for "Other". */
  id: string | null;
}

export interface SeriesPoint {
  t: number;
  total: number;
  [key: string]: number;
}

/** What the record said this finding put at risk at time t (0 before its first version and after a fix). */
export function revenueAt(item: SeriesItem, t: number): number {
  if (item.resolvedAt !== null && t >= item.resolvedAt) return 0;
  const v = item.versions.find((x) => x.recorded_from <= t && (x.recorded_to === null || t < x.recorded_to));
  return v ? v.revenue_at_risk_minor : 0;
}

/**
 * `buckets + 1` evenly spaced points from `from` to `to`. The `top` findings with the most at risk at `to` (or, when
 * all are fixed, at their peak) get their own key (k0, k1, ...); the rest add up under "other".
 */
export function revenueSeries(items: readonly SeriesItem[], from: number, to: number, buckets = 48, top = 5): { points: SeriesPoint[]; keys: SeriesKey[] } {
  const span = Math.max(1, to - from);
  const times = Array.from({ length: buckets + 1 }, (_, i) => Math.round(from + (span * i) / buckets));
  const weight = (it: SeriesItem) => Math.max(revenueAt(it, to), ...times.map((t) => revenueAt(it, t)));
  const ranked = [...items].sort((a, b) => weight(b) - weight(a) || a.title.localeCompare(b.title));
  const named = ranked.slice(0, top).filter((it) => weight(it) > 0);
  const rest = ranked.filter((it) => !named.includes(it));
  const keys: SeriesKey[] = named.map((it, i) => ({ key: `k${i}`, label: it.title, id: it.id }));
  if (rest.length > 0) keys.push({ key: 'other', label: `${rest.length} other issue${rest.length === 1 ? '' : 's'}`, id: null });

  const points = times.map((t) => {
    const p: SeriesPoint = { t, total: 0 };
    named.forEach((it, i) => {
      const v = revenueAt(it, t);
      p[`k${i}`] = v;
      p.total += v;
    });
    if (rest.length > 0) {
      const v = rest.reduce((n, it) => n + revenueAt(it, t), 0);
      p.other = v;
      p.total += v;
    }
    return p;
  });
  return { points, keys };
}
