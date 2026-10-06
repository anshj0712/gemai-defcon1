import { createHash } from 'node:crypto';
import type { Cluster, ClusterEvidence, ClusterKind, SignalRow } from '@cp/schema';

/**
 * Pure clustering logic: which cluster a signal belongs to, and how it changes that cluster.
 *
 * One broken thing produces several symptoms, so signals are keyed coarser than their per-detector
 * fingerprints: element signals (dead_click, rage_click, response_decay, and error_correlation, which
 * inherits its trigger's element) by tenant + route + normalized selector; invariant signals by
 * tenant + rule id. Each bug then collapses into one cluster across every affected session.
 */

export interface ClusterKey {
  cluster_id: string;
  kind: ClusterKind;
  anchor: string;
  route: string;
}

export const LIMITS = { sessions: 5000, evidence: 5, fingerprints: 50 } as const;

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 20);

const values = (row: SignalRow) => (row.evidence?.values ?? {}) as Record<string, unknown>;

export function clusterKeyFor(row: SignalRow): ClusterKey {
  const ruleId = typeof values(row).rule_id === 'string' ? (values(row).rule_id as string) : null;
  if (row.detector === 'invariant_check' || (!row.element_selector && ruleId)) {
    const anchor = ruleId ?? 'unknown_rule';
    return { kind: 'invariant', anchor, route: row.route, cluster_id: hash(`${row.tenant_id}|invariant|${anchor}`) };
  }
  const anchor = row.element_selector ?? '(element not identified)';
  return { kind: 'element', anchor, route: row.route, cluster_id: hash(`${row.tenant_id}|element|${row.route}|${anchor}`) };
}

/** Plain-language title from the cluster's symptoms. Invariant clusters keep their rule's title. */
export function titleFor(c: Pick<Cluster, 'kind' | 'anchor' | 'route' | 'detectors' | 'error_signatures'>, ruleTitle?: string): string {
  if (c.kind === 'invariant') return ruleTitle ?? `Rule ${c.anchor} violated`;
  const has = (d: string) => (c.detectors[d] ?? 0) > 0;
  if (Object.keys(c.error_signatures).length > 0) return `Failing ${c.anchor} on ${c.route}`;
  if (has('dead_click') || has('response_decay')) return `Unresponsive ${c.anchor} on ${c.route}`;
  if (has('rage_click')) return `Rage-clicked ${c.anchor} on ${c.route}`;
  return `${c.anchor} on ${c.route}`;
}

/** Newest first, preferring distinct sessions, at most LIMITS.evidence. */
function mergeEvidence(existing: readonly ClusterEvidence[], item: ClusterEvidence): ClusterEvidence[] {
  const all = [item, ...existing.filter((e) => e.signal_id !== item.signal_id)].sort((a, b) => b.event_time - a.event_time);
  const seen = new Set<string>();
  const distinct = all.filter((e) => !seen.has(e.session_id) && seen.add(e.session_id));
  const rest = all.filter((e) => !distinct.includes(e));
  return [...distinct, ...rest].slice(0, LIMITS.evidence);
}

/** The cluster after one more signal. Pure; never mutates `current`. */
export function applySignal(current: Cluster | null, row: SignalRow, key: ClusterKey, now: number): Cluster {
  const v = values(row);
  const base: Cluster = current
    ? structuredClone(current)
    : {
        v: 1,
        tenant_id: row.tenant_id,
        cluster_id: key.cluster_id,
        kind: key.kind,
        title: '',
        route: key.route,
        anchor: key.anchor,
        detectors: {},
        signal_count: 0,
        session_count: 0,
        sessions: [],
        releases: {},
        fingerprints: [],
        error_signatures: {},
        first_seen: row.event_time,
        last_seen: row.event_time,
        created_at: now,
        updated_at: now,
        evidence: [],
      };

  base.detectors[row.detector] = (base.detectors[row.detector] ?? 0) + 1;
  base.signal_count += 1;
  if (!base.sessions.includes(row.session_id)) {
    // Past the cap, sessions are still counted but no longer listed (the count may then over-count repeats).
    if (base.sessions.length < LIMITS.sessions) base.sessions.push(row.session_id);
    base.session_count += 1;
  }
  base.releases[row.release] = (base.releases[row.release] ?? 0) + 1;
  if (!base.fingerprints.includes(row.fingerprint) && base.fingerprints.length < LIMITS.fingerprints) base.fingerprints.push(row.fingerprint);
  if (typeof v.error_signature === 'string') base.error_signatures[v.error_signature] = (base.error_signatures[v.error_signature] ?? 0) + 1;
  base.first_seen = Math.min(base.first_seen, row.event_time);
  base.last_seen = Math.max(base.last_seen, row.event_time);
  base.updated_at = now;
  base.evidence = mergeEvidence(base.evidence, {
    signal_id: row.signal_id,
    session_id: row.session_id,
    seq: row.seq,
    detector: row.detector,
    event_time: row.event_time,
    selector: row.element_selector,
    route: row.route,
  });
  const ruleTitle = typeof v.rule_title === 'string' ? v.rule_title : undefined;
  base.title = base.kind === 'invariant' && base.title ? base.title : titleFor(base, ruleTitle);
  return base;
}
