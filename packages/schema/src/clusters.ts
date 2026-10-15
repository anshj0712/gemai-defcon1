/**
 * Clusters: signals grouped across sessions by the broken thing they point at (Phase 2). One broken
 * control shows up as several symptoms (dead clicks, rage clicks, response decay, correlated errors),
 * so element signals group by route + element, and invariant signals by rule. Clusters are derived
 * state, rebuildable from the signals table; Phase 3 scores them into versioned findings.
 */

export type ClusterKind = 'element' | 'invariant';

/** A pointer back to one signal, enough to open the replay at that moment. */
export interface ClusterEvidence {
  signal_id: string;
  session_id: string;
  seq: number;
  detector: string;
  event_time: number;
  selector: string | null;
  route: string;
}

export interface Cluster {
  v: 1;
  tenant_id: string;
  cluster_id: string;
  kind: ClusterKind;
  /** Deterministic title, for example "Unresponsive button#apply-coupon on /cart". */
  title: string;
  route: string;
  /** Normalized selector (element) or rule id (invariant). */
  anchor: string;
  /** Signal count per detector: the cluster's symptoms. */
  detectors: Record<string, number>;
  signal_count: number;
  session_count: number;
  /** Affected session ids, capped; session_count keeps counting past the cap. */
  sessions: string[];
  releases: Record<string, number>;
  fingerprints: string[];
  /** Error signatures attached by error_correlation, with counts. */
  error_signatures: Record<string, number>;
  /** Valid time of the first and latest signal. */
  first_seen: number;
  last_seen: number;
  /** Transaction time. */
  created_at: number;
  updated_at: number;
  /** The latest evidence items, newest first, at most five. */
  evidence: ClusterEvidence[];
  /** Phase 4: sessions a retroactive re-scan added (absent until one does). */
  found_later?: ClusterFoundLater;
}

/** Sessions that were hurt before the rule that flags them existed, found by re-scanning history. */
export interface ClusterFoundLater {
  /** Sessions first added to this issue by a re-scan signal (a session first added live is not counted). */
  sessions: number;
  /** Re-scan id -> sessions it added. */
  rescans: Record<string, number>;
}
