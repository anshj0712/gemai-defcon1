import type { FindingSummary } from '@cp/schema';
import type { ClusterSummary } from '../api';

/** Scored issues first in finding order (tier, then score); issues the agent has not scored yet after them, newest first. */
export function rankIssues(clusters: readonly ClusterSummary[], findings: readonly FindingSummary[]): { cluster: ClusterSummary; finding: FindingSummary | null }[] {
  const byCluster = new Map(clusters.map((c) => [c.cluster_id, c]));
  const scored = findings.filter((f) => byCluster.has(f.cluster_id)).map((f) => ({ cluster: byCluster.get(f.cluster_id)!, finding: f }));
  const seen = new Set(scored.map((s) => s.cluster.cluster_id));
  const unscored = clusters.filter((c) => !seen.has(c.cluster_id)).map((c) => ({ cluster: c, finding: null }));
  return [...scored, ...unscored];
}
