import type { ClusterSummary, SignalRowView } from '../api';

export interface SignalGroup {
  /** The issue these signals belong to, or null for signals no issue has taken yet. */
  cluster: ClusterSummary | null;
  signals: SignalRowView[];
  /** The newest signal's time. */
  lastSeen: number;
  /** Signals per detector, most first. */
  detectors: [string, number][];
}

/**
 * Signals grouped under the issue that clustered them: a signal belongs to the issue whose fingerprints include its
 * fingerprint (the clusterer's own key). Groups come newest first; signals not in any issue come last.
 */
export function groupSignals(signals: readonly SignalRowView[], clusters: readonly ClusterSummary[]): SignalGroup[] {
  const byFingerprint = new Map<string, ClusterSummary>();
  for (const c of clusters) for (const fp of c.fingerprints) if (!byFingerprint.has(fp)) byFingerprint.set(fp, c);

  const groups = new Map<string, { cluster: ClusterSummary | null; signals: SignalRowView[] }>();
  for (const s of signals) {
    const c = byFingerprint.get(s.fingerprint) ?? null;
    const key = c?.cluster_id ?? '';
    const g = groups.get(key) ?? { cluster: c, signals: [] };
    g.signals.push(s);
    groups.set(key, g);
  }

  const out: SignalGroup[] = [...groups.values()].map((g) => {
    const counts = new Map<string, number>();
    for (const s of g.signals) counts.set(s.detector, (counts.get(s.detector) ?? 0) + 1);
    return {
      cluster: g.cluster,
      signals: [...g.signals].sort((a, b) => b.event_time - a.event_time),
      lastSeen: Math.max(...g.signals.map((s) => s.event_time)),
      detectors: [...counts.entries()].sort((a, b) => b[1] - a[1]),
    };
  });
  return out.sort((a, b) => Number(a.cluster === null) - Number(b.cluster === null) || b.lastSeen - a.lastSeen);
}
