import { gunzipSync } from 'node:zlib';
import { runDetectors, toSignalRows, type DetectorRun, type ParamOverrides } from '@cp/detectors';
import type { Logger } from '@cp/logger';
import { emptyState, normalize } from '@cp/normalizer';
import type { BlobStore, InsertRow, Publisher, StateStore, Warehouse } from '@cp/platform';
import {
  StoredChunk,
  type BusinessEventRow,
  type Detector,
  type InvariantRule,
  type NormalizedChunk,
  type NormalizedEvent,
  type RawChunkMessage,
  type RawChunkRow,
  type RecordedProbeSpec,
  type SessionTail,
  type SignalRow,
} from '@cp/schema';
import type { TailCache } from './tail-cache.js';

/** A message that can never succeed. It is acked (not retried) and logged loudly. */
export class PoisonMessageError extends Error {
  override name = 'PoisonMessageError';
}

/** An earlier chunk of the session has not been processed yet; retry this one later. */
export class ChunkGapError extends Error {
  override name = 'ChunkGapError';
}

export type ChunkOutcome = 'processed' | 'duplicate' | 'stale';

export interface ChunkHandlerDeps {
  blob: BlobStore;
  warehouse: Warehouse;
  publisher: Publisher;
  state: StateStore;
  tails: TailCache;
  signalsTopic: string;
  detectors: readonly Detector[];
  /** tenant -> detector -> params */
  overrides: Record<string, ParamOverrides>;
  /** The tenant's active invariant rules (see rules.ts); undefined means the built-in rules. */
  rulesFor?: (tenantId: string) => Promise<InvariantRule[] | undefined>;
  /** The tenant's active recorded probes (see probes.ts), read from the recorded page. */
  probesFor?: (tenantId: string) => Promise<RecordedProbeSpec[]>;
  /** Keep the recorded-page mirror for every session, so a probe added mid-session is read at once. */
  mirror?: boolean;
  lookbackMs: number;
  tailMaxEvents: number;
  markerTtlMs: number;
  /**
   * A chunk that arrives ahead of a missing earlier seq is sent back for redelivery while its
   * delivery attempt is below this, giving the missing chunk time to land. After that it is
   * processed anyway so a lost chunk cannot stall the session.
   */
  gapWaitAttempts: number;
  logger: Logger;
  now?: () => number;
}

export interface MessageMeta {
  messageId?: string | undefined;
  deliveryAttempt?: number | undefined;
}

/** Runs tasks for the same key one at a time, in arrival order. */
export class KeyedQueue {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.chains.set(key, next);
    const cleanup = () => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    };
    void next.then(cleanup, cleanup);
    return next;
  }
}

const eventEnd = (e: NormalizedEvent) => (e.kind === 'request' ? e.tEnd : e.t);

export function createChunkHandler(deps: ChunkHandlerDeps) {
  const queue = new KeyedQueue();
  return {
    handle(msg: RawChunkMessage, meta: MessageMeta = {}): Promise<ChunkOutcome> {
      return queue.run(`${msg.tenant_id}/${msg.session_id}`, () => processChunk(deps, msg, meta));
    },
  };
}

async function loadChunk(blob: BlobStore, msg: RawChunkMessage): Promise<StoredChunk> {
  let raw: Buffer;
  try {
    raw = await blob.get(msg.gcs_uri);
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    if (code === 404 || code === 'ENOENT') throw new PoisonMessageError(`raw chunk not found at ${msg.gcs_uri}`);
    throw err;
  }
  let stored: StoredChunk;
  try {
    stored = StoredChunk.parse(JSON.parse(gunzipSync(raw).toString('utf8')));
  } catch {
    throw new PoisonMessageError(`raw chunk at ${msg.gcs_uri} is not a valid stored chunk`);
  }
  if (stored.tenant_id !== msg.tenant_id || stored.envelope.session_id !== msg.session_id || stored.envelope.seq !== msg.seq) {
    throw new PoisonMessageError('message metadata does not match the stored chunk');
  }
  return stored;
}

async function processChunk(deps: ChunkHandlerDeps, msg: RawChunkMessage, meta: MessageMeta): Promise<ChunkOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  const ids = { tenant_id: msg.tenant_id, session_id: msg.session_id, seq: msg.seq };
  const log = deps.logger.child(ids);

  if (await deps.state.isProcessed(msg.tenant_id, msg.session_id, msg.seq)) {
    log.info({ message_id: meta.messageId, delivery_attempt: meta.deliveryAttempt }, 'chunk already processed; acking redelivery');
    return 'duplicate';
  }

  const tail = await deps.tails.get(msg.tenant_id, msg.session_id);
  // Ordering keys keep a session in order, so an older seq means the SDK re-sent out of order. Its raw
  // chunk is stored and indexed; detection is skipped rather than run against a tail that moved on.
  const stale = tail !== null && msg.seq <= tail.last_seq;

  const expected = tail ? tail.last_seq + 1 : 0;
  const attempt = meta.deliveryAttempt;
  // Pub/Sub only reports delivery attempts when a dead-letter policy is set; without a count, don't wait.
  if (msg.seq > expected && typeof attempt === 'number' && attempt > 0 && attempt < deps.gapWaitAttempts) {
    throw new ChunkGapError(`waiting for seq ${expected} before seq ${msg.seq} (attempt ${attempt} of ${deps.gapWaitAttempts})`);
  }

  const stored = await loadChunk(deps.blob, msg);
  const env = stored.envelope;
  // Valid time = client time + (collector receive time - client send time).
  const skewMs = msg.collector_received_at - msg.client_sent_at;
  const ingestTime = now();

  const rawRow: RawChunkRow = {
    ...ids,
    gcs_uri: msg.gcs_uri,
    bytes: msg.bytes,
    event_count: env.events.length,
    event_time_start: env.client_ts_start + skewMs,
    event_time_end: env.client_ts_end + skewMs,
    ingest_time: ingestTime,
    client_sent_at: env.client_sent_at,
    collector_received_at: stored.collector_received_at,
    release: env.release,
    route: env.page.route,
    sdk_version: env.sdk_version,
    sample_rate: env.sample_rate ?? null,
  };
  const businessRows: InsertRow<BusinessEventRow>[] = env.business_events.map((b, i) => ({
    insertId: `${msg.tenant_id}:${msg.session_id}:${msg.seq}:be${i}`,
    row: {
      ...ids,
      name: b.name,
      value_minor: b.value_minor ?? null,
      currency: b.currency ?? null,
      event_time: (b.ts ?? env.client_ts_end) + skewMs,
      ingest_time: ingestTime,
    },
  }));

  let signalRows: InsertRow<SignalRow>[] = [];
  let newTail: SessionTail | null = null;
  let runs: DetectorRun[] = [];
  let stats: ReturnType<typeof normalize>['stats'] | null = null;

  if (!stale) {
    const rules = await deps.rulesFor?.(msg.tenant_id);
    const recordedProbes = (await deps.probesFor?.(msg.tenant_id)) ?? [];
    const norm = normalize(env.events, { seq: msg.seq, skewMs, state: tail?.state ?? emptyState(), recordedProbes, mirror: deps.mirror ?? false });
    stats = norm.stats;
    const lastEvent = norm.events.reduce((m, e) => Math.max(m, eventEnd(e)), Number.NEGATIVE_INFINITY);
    const chunk: NormalizedChunk = {
      sessionId: msg.session_id,
      seq: msg.seq,
      route: env.page.route,
      tStart: env.client_ts_start + skewMs,
      tEnd: Math.max(env.client_ts_end + skewMs, lastEvent),
      events: norm.events,
    };
    runs = runDetectors(
      deps.detectors,
      {
        tenantId: msg.tenant_id,
        sessionId: msg.session_id,
        release: env.release,
        route: env.page.route,
        tail: tail?.events ?? [],
        prevHorizon: tail?.horizon ?? null,
      },
      chunk,
      deps.overrides[msg.tenant_id],
      {
        ...(tail?.detector_state ? { state: tail.detector_state } : {}),
        ...(rules ? { rules } : {}),
      },
    );
    signalRows = toSignalRows(runs, { tenantId: msg.tenant_id, sessionId: msg.session_id, pageRoute: env.page.route, release: env.release, ingestTime }).map((row) => ({
      insertId: row.signal_id,
      row,
    }));
    const cutoff = chunk.tEnd - deps.lookbackMs;
    newTail = {
      v: 1,
      tenant_id: msg.tenant_id,
      session_id: msg.session_id,
      last_seq: msg.seq,
      horizon: chunk.tEnd,
      events: [...(tail?.events ?? []), ...norm.events].filter((e) => eventEnd(e) >= cutoff).slice(-deps.tailMaxEvents),
      state: norm.state,
      // A detector that threw keeps its previous state; the others replace theirs.
      detector_state: {
        ...tail?.detector_state,
        ...Object.fromEntries(runs.filter((r) => 'state' in r && !r.error).map((r) => [r.detector.id, r.state])),
      },
      updated_at: ingestTime,
    };
  }

  // Appends are idempotent through their insertIds, so a retry after a partial failure is safe.
  await deps.warehouse.insert('raw_chunks', [{ insertId: `${msg.tenant_id}:${msg.session_id}:${msg.seq}`, row: rawRow }]);
  await deps.warehouse.insert('business_events', businessRows);
  await deps.warehouse.insert('signals', signalRows);
  await Promise.all(
    signalRows.map((r) =>
      deps.publisher.publish(deps.signalsTopic, r.row, {
        attributes: { tenant_id: r.row.tenant_id, detector: r.row.detector, fingerprint: r.row.fingerprint },
      }),
    ),
  );
  if (newTail) await deps.tails.put(newTail);
  await deps.state.markProcessed(msg.tenant_id, msg.session_id, msg.seq, deps.markerTtlMs);

  for (const run of runs) {
    if (run.error) log.error({ err: run.error, detector: run.detector.id }, 'detector threw; its signals for this chunk are missing');
  }
  for (const { row } of signalRows) {
    log.info(
      { detector: row.detector, fingerprint: row.fingerprint, route: row.route, selector: row.element_selector, event_seq: row.seq, rule_version: row.rule_version },
      `signal: ${row.detector}`,
    );
  }
  const fields = {
    event_count: env.events.length,
    ...(stats ? { clicks: stats.clicks, mutations: stats.mutations, requests: stats.requests } : {}),
    signals: signalRows.length,
    business_event_count: businessRows.length,
    lag_ms: ingestTime - (env.client_ts_end + skewMs),
    ms: now() - started,
  };
  if (stale) {
    log.warn({ ...fields, last_seq: tail?.last_seq }, 'chunk arrived behind the session tail; indexed without detection');
    return 'stale';
  }
  if (msg.seq > expected) log.warn({ expected_seq: expected }, 'processed with earlier chunks missing');
  log.info(fields, 'chunk processed');
  return 'processed';
}
