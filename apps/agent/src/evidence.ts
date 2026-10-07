import { describe as describeSignal, formatMoney } from '@cp/platform';
import type { Cluster, EvidenceItem, FindingScreenshot, RevenueAtRisk, SignalRow } from '@cp/schema';

/**
 * The evidence pack: the only thing the agents see (AGENTS.md rule 2). It is built from the cluster,
 * a few of its signals, the revenue inputs, and (for the root-cause agent) a screenshot rendered from
 * the already-masked replay. No raw rrweb events, no HTML, no session ids, no typed text: detector
 * facts, normalized selectors, normalized error signatures, and numbers.
 */

/** Most signal items in a pack (the cluster keeps its five newest, one per session where possible). */
export const MAX_SIGNAL_ITEMS = 5;
export const MAX_ERROR_ITEMS = 3;

const SAFE_KEY = /^[a-z][a-z0-9_]{0,39}$/;
/** Detector values the model has no use for (node ids are replay internals). */
const DROP_KEYS = new Set(['node_id', 'highlight_probe']);

/** Keep primitive detector values only: numbers, booleans, and short strings. */
export function sanitizeValues(values: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!values || typeof values !== 'object') return out;
  for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
    if (!SAFE_KEY.test(k) || DROP_KEYS.has(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 160) out[k] = v;
  }
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString();

export interface EvidenceInput {
  cluster: Cluster;
  /** Signal rows for (some of) the cluster's evidence items, matched by signal_id. */
  signals: readonly SignalRow[];
  revenue: RevenueAtRisk;
  regression: boolean;
}

/** Ids are assigned in a fixed order (E1, E2, ...) so the same inputs give the same pack. */
export function buildEvidence(input: EvidenceInput): EvidenceItem[] {
  const c = input.cluster;
  const items: EvidenceItem[] = [];
  const next = () => `E${items.length + 1}`;
  const symptoms = Object.entries(c.detectors)
    .sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `${d} x${n}`)
    .join(', ');

  items.push({
    id: next(),
    kind: 'issue',
    text: `${c.kind === 'invariant' ? 'Data rule' : 'Element'} issue "${c.title}" on ${c.route} (anchor ${c.anchor}): ${c.signal_count} signals across ${c.session_count} sessions; symptoms ${symptoms}; first seen ${iso(c.first_seen)}, last seen ${iso(c.last_seen)}.`,
    data: { kind: c.kind, route: c.route, anchor: c.anchor, signals: c.signal_count, sessions: c.session_count, ...Object.fromEntries(Object.entries(c.detectors).map(([d, n]) => [`symptom_${d}`, n])) },
  });

  const byId = new Map(input.signals.map((s) => [s.signal_id, s]));
  for (const e of c.evidence.slice(0, MAX_SIGNAL_ITEMS)) {
    const row = byId.get(e.signal_id);
    items.push({
      id: next(),
      kind: 'signal',
      text: row ? `${describeSignal(row)} (route ${row.route}, release ${row.release}).` : `${e.detector} on ${e.selector ?? 'an element'} (route ${e.route}).`,
      signal_id: e.signal_id,
      session_id: e.session_id,
      detector: e.detector,
      at: e.event_time,
      data: { detector: e.detector, selector: e.selector, route: e.route, ...(row ? { detector_version: row.detector_version, release: row.release, ...sanitizeValues(row.evidence.values) } : {}) },
    });
  }

  for (const [sig, n] of Object.entries(c.error_signatures)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ERROR_ITEMS)) {
    items.push({ id: next(), kind: 'error', text: `Error "${sig}" was seen within 2 s before a symptom, ${n} times.`, data: { signature: sig, count: n } });
  }

  const releases = Object.entries(c.releases).sort((a, b) => b[1] - a[1]);
  items.push({
    id: next(),
    kind: 'release',
    text: `Signals by release: ${releases.map(([r, n]) => `${r} (${n})`).join(', ')}.${input.regression ? ' The issue first appeared right after this release went out.' : ''}`,
    data: { releases: releases.length, regression: input.regression, ...Object.fromEntries(releases.slice(0, 5).map(([r, n], i) => [`release_${i + 1}`, `${r}:${n}`])) },
  });

  const r = input.revenue;
  const pct = (x: number | null) => (x === null ? 'unknown' : `${Math.round(x * 100)}%`);
  items.push({
    id: next(),
    kind: 'impact',
    text:
      r.status === 'ok'
        ? `Synthetic demo data. ${r.affected_abandoned} of ${r.affected_decided} affected sessions with a cart abandoned (${pct(r.abandonment_affected)}) versus ${pct(r.abandonment_baseline)} of baseline sessions (${r.baseline_scope} baseline); average cart ${formatMoney(r.avg_cart_value_minor, r.currency)}; estimated revenue at risk ${formatMoney(r.revenue_at_risk_minor, r.currency)}.`
        : `Synthetic demo data. Revenue at risk not estimated yet: ${r.note ?? 'insufficient data'}`,
    data: {
      status: r.status,
      affected_with_cart: r.affected_with_cart,
      abandonment_affected: r.abandonment_affected,
      abandonment_baseline: r.abandonment_baseline,
      avg_cart_value_minor: r.avg_cart_value_minor,
      revenue_at_risk_minor: r.revenue_at_risk_minor,
      currency: r.currency,
    },
  });
  return items;
}

/** The screenshot as an evidence item (root-cause agent only). */
export function screenshotEvidence(id: string, shot: Omit<FindingScreenshot, 'evidence_id'>, flagged: EvidenceItem | undefined): EvidenceItem {
  return {
    id,
    kind: 'screenshot',
    text: `Screenshot rendered from the masked replay ${Math.round(shot.offset_ms / 100) / 10} s into the session, at the flagged moment of ${flagged?.id ?? 'the latest signal'}; the flagged element is outlined in red. Inputs and personal text are masked.`,
    signal_id: shot.signal_id,
    session_id: shot.session_id,
    data: { offset_ms: shot.offset_ms, of: flagged?.id ?? null },
  };
}

/** What the model sees for each item: id, kind, text, time, and data. Signal and session ids stay out. */
export function forModel(items: readonly EvidenceItem[]): unknown[] {
  return items.map((i) => ({ id: i.id, kind: i.kind, text: i.text, ...(i.at !== undefined ? { at: iso(i.at) } : {}), ...(i.data ? { data: i.data } : {}) }));
}
