import { emptyState, normalize } from '@cp/normalizer';
import { loadStoredChunk, type BlobStore, type WarehouseReader } from '@cp/platform';
import type { NormalizerState, ProbeEvent, RawChunkRow } from '@cp/schema';

/**
 * Reads a valid-time window of sessions back from raw (rule 3: raw chunks are the record) and keeps
 * their probe snapshots: the fast path of ARCHITECTURE.md section 6. Chunks are normalized in seq
 * order with carried state and the same skew correction as the processor, so a rule evaluated here
 * sees exactly what live detection would have seen.
 */

/** One stored chunk's probe snapshots, with what a signal row needs from its chunk. */
export interface ProbeChunk {
  seq: number;
  pageRoute: string;
  release: string;
  /** Skew-corrected valid time of the batch. */
  tStart: number;
  tEnd: number;
  probes: ProbeEvent[];
}

export interface SessionProbes {
  session_id: string;
  chunks: ProbeChunk[];
}

export interface ScanOptions {
  tenantId: string;
  fromMs: number;
  toMs: number;
  maxSessions: number;
  /** Sessions read in parallel. */
  concurrency: number;
  /** Called once the window is listed, before any session is read. */
  onListed?: (sessions: number, truncated: boolean) => Promise<void> | void;
  onSession: (session: SessionProbes) => Promise<void> | void;
  onError?: (sessionId: string, err: unknown) => void;
}

export interface ScanSummary {
  sessions_total: number;
  sessions_scanned: number;
  sessions_failed: number;
  chunks_scanned: number;
  truncated: boolean;
}

/** Load, normalize, and keep the probes of one session's chunks (seq order). */
export async function sessionProbes(blob: BlobStore, tenantId: string, sessionId: string, rows: readonly RawChunkRow[]): Promise<SessionProbes> {
  let state: NormalizerState = emptyState();
  const chunks: ProbeChunk[] = [];
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    const stored = await loadStoredChunk(blob, row.gcs_uri, tenantId);
    const env = stored.envelope;
    if (env.session_id !== sessionId || env.seq !== row.seq) throw new Error('stored chunk does not match its index row');
    // Valid time = client time + (collector receive time - client send time), as in the processor.
    const skewMs = stored.collector_received_at - env.client_sent_at;
    const norm = normalize(env.events, { seq: row.seq, skewMs, state });
    state = norm.state;
    chunks.push({
      seq: row.seq,
      pageRoute: env.page.route,
      release: env.release,
      tStart: env.client_ts_start + skewMs,
      tEnd: env.client_ts_end + skewMs,
      probes: norm.events.filter((e): e is ProbeEvent => e.kind === 'probe'),
    });
  }
  return { session_id: sessionId, chunks };
}

/** Stream every session in the window (newest first, capped) through `onSession`, `concurrency` at a time. */
export async function scanWindow(deps: { reader: WarehouseReader; blob: BlobStore }, opts: ScanOptions): Promise<ScanSummary> {
  const listed = await deps.reader.chunksInWindow(opts.tenantId, opts.fromMs, opts.toMs, opts.maxSessions);
  const bySession = new Map<string, RawChunkRow[]>();
  for (const c of listed.chunks) {
    const list = bySession.get(c.session_id) ?? [];
    list.push(c);
    bySession.set(c.session_id, list);
  }
  const queue = [...bySession.entries()];
  const summary: ScanSummary = { sessions_total: queue.length, sessions_scanned: 0, sessions_failed: 0, chunks_scanned: 0, truncated: listed.truncated };
  await opts.onListed?.(queue.length, listed.truncated);
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [sessionId, rows] = next;
      try {
        const session = await sessionProbes(deps.blob, opts.tenantId, sessionId, rows);
        await opts.onSession(session);
        summary.sessions_scanned += 1;
        summary.chunks_scanned += rows.length;
      } catch (err) {
        summary.sessions_failed += 1;
        opts.onError?.(sessionId, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, queue.length)) }, worker));
  return summary;
}
