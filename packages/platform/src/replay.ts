import { gunzipSync } from 'node:zlib';
import { StoredChunk, type RawChunkRow, type RrwebEvent, type SignalRow } from '@cp/schema';
import type { BlobStore } from './blob.js';
import type { WarehouseReader } from './warehouse.js';

/** One flagged moment, placed on the replay's own clock (the browser's timestamps). */
export interface ReplayMarker {
  signal_id: string;
  detector: string;
  label: string;
  /** Browser-clock ms: where the flagged event sits among the rrweb events. */
  replay_ts: number;
  /** Valid time (skew-corrected), as stored on the signal. */
  event_time: number;
  seq: number;
  selector: string | null;
  node_id: number | null;
  fingerprint: string;
}

export interface ReplaySession {
  session_id: string;
  tenant_id: string;
  chunks: number;
  release: string;
  route: string;
  started_at: number;
  ended_at: number;
}

export interface ReplayPayload {
  session: ReplaySession;
  events: RrwebEvent[];
  markers: ReplayMarker[];
}

/** Concatenate chunks in seq order (one per seq), keeping event order stable by timestamp. */
export function stitchEvents(chunks: { seq: number; stored: StoredChunk }[]): RrwebEvent[] {
  const bySeq = new Map<number, StoredChunk>();
  for (const c of chunks) if (!bySeq.has(c.seq)) bySeq.set(c.seq, c.stored);
  const ordered = [...bySeq.entries()].sort(([a], [b]) => a - b).flatMap(([, s]) => s.envelope.events);
  return ordered
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.timestamp - b.e.timestamp || a.i - b.i)
    .map(({ e }) => e);
}

/** Per-chunk clock skew the processor applied: collector_received_at - client_sent_at. */
export function skewBySeq(rows: RawChunkRow[]): Map<number, number> {
  return new Map(rows.map((r) => [r.seq, r.collector_received_at - r.client_sent_at]));
}

/** Money in minor units, formatted for captions (for example ₹21,176.15). */
export function formatMoney(minor: unknown, currency: unknown): string {
  if (typeof minor !== 'number') return '?';
  const code = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : undefined;
  return code
    ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(minor / 100)
    : (minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** One plain-language line per flagged moment, shown as the replay caption. */
export function describe(signal: SignalRow): string {
  const selector = signal.element_selector ?? 'an element';
  const v = (signal.evidence.values ?? {}) as Record<string, unknown>;
  switch (signal.detector) {
    case 'dead_click':
      return `Dead click on ${selector}: no response within ${String(v.window_ms ?? '?')} ms`;
    case 'rage_click': {
      const span = typeof v.span_ms === 'number' ? (v.span_ms / 1000).toFixed(1) : '?';
      return `Rage clicks on ${selector}: ${String(v.clicks ?? '?')} clicks in ${span} s, ${String(v.failed ?? '?')} failed`;
    }
    case 'response_decay':
      return `${selector} stopped responding after working ${String(v.answered_before ?? '?')} times`;
    case 'invariant_check':
      return `${String(v.rule_title ?? 'Rule violated')}: shows ${formatMoney(v.actual, v.currency)}, expected ${formatMoney(v.expected, v.currency)}`;
    case 'error_correlation':
      return `${String(v.error_signature ?? 'An error')} right before the ${String(v.correlated_detector ?? 'signal').replace('_', ' ')} on ${selector}`;
    default:
      return `${signal.detector} on ${selector}`;
  }
}

/** Element to outline in the replay: the signal's element, or a probe's element for invariant rules. */
function highlightSelector(s: SignalRow, evidenceSelector: string | undefined): string | null {
  const probe = (s.evidence.values as Record<string, unknown> | undefined)?.highlight_probe;
  if (typeof probe === 'string' && /^[a-z][a-z0-9_]*$/.test(probe)) return `[data-cp-probe="${probe}"]`;
  return evidenceSelector ?? s.element_selector;
}

/** Place each signal on the replay clock by undoing the skew of the chunk its event came from. */
export function toMarkers(signals: SignalRow[], skew: Map<number, number>): ReplayMarker[] {
  return signals
    .map((s) => {
      const evidence = s.evidence as { seq?: number; tStart?: number; selector?: string; values?: Record<string, unknown> };
      const seq = typeof evidence.seq === 'number' ? evidence.seq : s.seq;
      const validStart = typeof evidence.tStart === 'number' ? evidence.tStart : s.event_time;
      const nodeId = evidence.values?.node_id;
      return {
        signal_id: s.signal_id,
        detector: s.detector,
        label: describe(s),
        replay_ts: validStart - (skew.get(seq) ?? 0),
        event_time: s.event_time,
        seq,
        selector: highlightSelector(s, evidence.selector),
        node_id: typeof nodeId === 'number' ? nodeId : null,
        fingerprint: s.fingerprint,
      };
    })
    .sort((a, b) => a.replay_ts - b.replay_ts);
}

export class SessionTooLongError extends Error {
  override name = 'SessionTooLongError';
  constructor(readonly chunks: number) {
    super(`session has ${chunks} chunks`);
  }
}

/**
 * A session's stored (already scrubbed) chunks, stitched for replay, with its flagged moments.
 * Returns null when the session has no chunks in the window. Every chunk must belong to `tenantId`.
 */
export async function loadReplay(
  deps: { reader: WarehouseReader; blob: BlobStore },
  tenantId: string,
  sessionId: string,
  opts: { sinceMs: number; maxChunks: number },
): Promise<ReplayPayload | null> {
  const rows = await deps.reader.rawChunks(tenantId, sessionId, opts.sinceMs);
  if (rows.length === 0) return null;
  if (rows.length > opts.maxChunks) throw new SessionTooLongError(rows.length);
  const chunks = await Promise.all(
    rows.map(async (r) => {
      const stored = StoredChunk.parse(JSON.parse(gunzipSync(await deps.blob.get(r.gcs_uri)).toString('utf8')));
      if (stored.tenant_id !== tenantId) throw new Error('stored chunk belongs to another tenant');
      return { seq: r.seq, stored };
    }),
  );
  const signals = await deps.reader.signals({ tenantId, sessionId, sinceMs: opts.sinceMs, limit: 500 });
  const first = rows[0]!;
  const last = rows.at(-1)!;
  return {
    session: {
      session_id: sessionId,
      tenant_id: tenantId,
      chunks: rows.length,
      release: last.release,
      route: last.route,
      started_at: first.event_time_start,
      ended_at: last.event_time_end,
    },
    events: stitchEvents(chunks),
    markers: toMarkers(signals, skewBySeq(rows)),
  };
}
