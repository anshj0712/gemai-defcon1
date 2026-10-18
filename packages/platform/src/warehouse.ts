import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BigQuery } from '@google-cloud/bigquery';
import { BQ_TABLES, type BusinessEventRow, type FindingRow, type RawChunkRow, type RowTypes, type SignalRow, type TableName } from '@cp/schema';

export interface InsertRow<T> {
  /** Deterministic id; BigQuery uses it for best-effort dedupe, local mode for exact dedupe. */
  insertId: string;
  row: T;
}

export interface Warehouse {
  insert<T extends TableName>(table: T, rows: InsertRow<RowTypes[T]>[]): Promise<void>;
}

/** Converts a row to BigQuery's streaming JSON: epoch ms -> ISO timestamp, objects -> JSON strings. */
export function toBigQueryRow(table: TableName, row: object): Record<string, unknown> {
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of BQ_TABLES[table].fields) {
    const v = source[field.name];
    if (v === undefined || v === null) {
      out[field.name] = null;
    } else if (field.type === 'TIMESTAMP') {
      out[field.name] = new Date(v as number).toISOString();
    } else if (field.type === 'JSON') {
      out[field.name] = JSON.stringify(v);
    } else {
      out[field.name] = v;
    }
  }
  return out;
}

export class BigQueryWarehouse implements Warehouse {
  constructor(
    private readonly bq: BigQuery,
    private readonly dataset: string,
  ) {}

  async insert<T extends TableName>(table: T, rows: InsertRow<RowTypes[T]>[]): Promise<void> {
    if (rows.length === 0) return;
    try {
      await this.bq
        .dataset(this.dataset)
        .table(table)
        .insert(
          rows.map((r) => ({ insertId: r.insertId, json: toBigQueryRow(table, r.row) })),
          { raw: true },
        );
    } catch (err) {
      // PartialFailureError lists per-row errors. Surface the reasons only, never row contents.
      const perRow = (err as { errors?: { errors?: { reason?: string; message?: string }[] }[] }).errors;
      if (Array.isArray(perRow)) {
        const reasons = [...new Set(perRow.flatMap((e) => (e.errors ?? []).map((x) => `${x.reason}: ${x.message}`)))];
        throw new Error(`BigQuery insert into ${table} failed for ${perRow.length} row(s): ${reasons.join('; ')}`);
      }
      throw err;
    }
  }
}

/** local mode: one `<table>.jsonl` per table, deduplicated on insertId. */
export class LocalWarehouse implements Warehouse {
  private readonly seen = new Map<string, Set<string>>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private file(table: string): string {
    return join(this.dir, `${table}.jsonl`);
  }

  private async ids(table: string): Promise<Set<string>> {
    let ids = this.seen.get(table);
    if (!ids) {
      ids = new Set((await this.rows(table)).map((r) => String(r._insert_id)));
      this.seen.set(table, ids);
    }
    return ids;
  }

  insert<T extends TableName>(table: T, rows: InsertRow<RowTypes[T]>[]): Promise<void> {
    const run = async () => {
      if (rows.length === 0) return;
      const ids = await this.ids(table);
      const fresh = rows.filter((r) => !ids.has(r.insertId));
      if (fresh.length === 0) return;
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.file(table), fresh.map((r) => `${JSON.stringify({ _insert_id: r.insertId, ...r.row })}\n`).join(''));
      for (const r of fresh) ids.add(r.insertId);
    };
    const next = this.chain.then(run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Every row stored for a table, in insert order. */
  async rows(table: string): Promise<Record<string, unknown>[]> {
    const file = this.file(table);
    if (!existsSync(file)) return [];
    const text = await readFile(file, 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

export interface SignalQuery {
  tenantId: string;
  sessionId?: string;
  /** Only signals with valid time at or after this (epoch ms). Also the partition filter. */
  sinceMs: number;
  limit: number;
}

/** Business events whose value is the shopper's current cart (the latest one wins). */
export const CART_EVENT_NAMES = ['cart_viewed', 'checkout_started', 'order_placed'] as const;
export const ORDER_EVENT_NAME = 'order_placed';

/**
 * One session's commerce outcome, the input to revenue at risk (AGENTS.md rule 9). Built from the
 * raw_chunks index and business_events only: no page content.
 */
export interface SessionOutcome {
  session_id: string;
  /** Batch routes the session visited. */
  routes: string[];
  releases: string[];
  /** Valid time of the first and last stored batch. */
  first_seen: number;
  last_seen: number;
  /** The SDK sampler's rate (null = not recorded, treat as 1). */
  sample_rate: number | null;
  /** Latest cart value seen (cart_viewed, checkout_started or order_placed), minor units. */
  cart_value_minor: number | null;
  currency: string | null;
  ordered: boolean;
}

/** Most session outcomes one scoring pass reads. */
export const MAX_OUTCOME_ROWS = 200_000;

/** The chunks of the newest sessions in a valid-time window (dry runs and re-scans read these from raw). */
export interface WindowChunks {
  /** One row per (session, seq), grouped by session (newest session first), seq order within a session. */
  chunks: RawChunkRow[];
  sessions: number;
  /** The window held more sessions than were returned. */
  truncated: boolean;
}

/** What did we believe at transaction time `asOf` about findings whose valid time overlaps [validFrom, validTo)? */
export interface AsOfQuery {
  tenantId: string;
  asOf: number;
  validFrom: number;
  validTo: number;
  /** Lower bound on valid_from: findings that began earlier are left out (partition pruning). */
  sinceMs: number;
}

/** Most finding versions an as-of query returns. */
export const MAX_ASOF_ROWS = 500;

/** Read side of the warehouse, for the API and the agent service. Every query is scoped to one tenant. */
export interface WarehouseReader {
  /** Newest first, one row per signal_id. */
  signals(q: SignalQuery): Promise<SignalRow[]>;
  /** A session's stored chunks in seq order, one row per seq. */
  rawChunks(tenantId: string, sessionId: string, sinceMs: number): Promise<RawChunkRow[]>;
  /** Every session that stored a batch since `sinceMs`, with its cart and order outcome. */
  sessionOutcomes(tenantId: string, sinceMs: number): Promise<SessionOutcome[]>;
  /** Every stored version of one finding, oldest first, with `recorded_to` derived from the next version. */
  findingVersions(tenantId: string, findingId: string, sinceMs: number): Promise<FindingRow[]>;
  /** Every version of every finding (the slim columns the revenue charts need), oldest first, `recorded_to` derived. One query for the whole chart. */
  findingsTimeline(tenantId: string, sinceMs: number): Promise<FindingRow[]>;
  /** Chunks starting in [fromMs, toMs) of the `maxSessions` most recently active sessions in that window. */
  chunksInWindow(tenantId: string, fromMs: number, toMs: number, maxSessions: number): Promise<WindowChunks>;
  /** The version of each finding current at `asOf` (one row per finding, `recorded_to` derived), highest score first. */
  findingsAsOf(q: AsOfQuery): Promise<FindingRow[]>;
}

/** Group chunk rows by session, keep the newest `maxSessions` sessions, one row per seq (the first ingested). */
export function pickWindowSessions(rows: readonly RawChunkRow[], maxSessions: number): WindowChunks {
  const bySession = new Map<string, { last: number; seqs: Map<number, RawChunkRow> }>();
  for (const r of rows) {
    let s = bySession.get(r.session_id);
    if (!s) bySession.set(r.session_id, (s = { last: r.event_time_end, seqs: new Map() }));
    s.last = Math.max(s.last, r.event_time_end);
    const prev = s.seqs.get(r.seq);
    if (!prev || r.ingest_time < prev.ingest_time) s.seqs.set(r.seq, r);
  }
  const ordered = [...bySession.entries()].sort((a, b) => b[1].last - a[1].last || (a[0] < b[0] ? -1 : 1));
  const kept = ordered.slice(0, Math.max(0, maxSessions));
  return {
    chunks: kept.flatMap(([, s]) => [...s.seqs.values()].sort((a, b) => a.seq - b.seq)),
    sessions: kept.length,
    truncated: ordered.length > kept.length,
  };
}

/**
 * The as-of rule on rows with `recorded_to` already derived: the version current at `asOf` (recorded at
 * or before it, not yet replaced), valid time overlapping the window. One row per finding.
 */
export function selectAsOf(rows: readonly FindingRow[], q: AsOfQuery): FindingRow[] {
  const byFinding = new Map<string, FindingRow>();
  for (const r of rows) {
    if (r.tenant_id !== q.tenantId || r.valid_from < q.sinceMs) continue;
    if (!(r.valid_from < q.validTo && (r.valid_to === null || r.valid_to > q.validFrom))) continue;
    if (!(r.recorded_from <= q.asOf && (r.recorded_to === null || r.recorded_to > q.asOf))) continue;
    const prev = byFinding.get(r.finding_id);
    if (!prev || r.recorded_from > prev.recorded_from) byFinding.set(r.finding_id, r);
  }
  return [...byFinding.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.recorded_from - a.recorded_from).slice(0, MAX_ASOF_ROWS);
}

/** Close each version at the next one's `recorded_from` (per finding), as the findings_versions view does. */
export function deriveRecordedTo(rows: readonly FindingRow[]): FindingRow[] {
  const byFinding = new Map<string, FindingRow[]>();
  for (const r of rows) {
    const list = byFinding.get(r.finding_id) ?? [];
    list.push(r);
    byFinding.set(r.finding_id, list);
  }
  return [...byFinding.values()].flatMap((list) => {
    list.sort((a, b) => a.recorded_from - b.recorded_from);
    return list.map((r, i) => ({ ...r, recorded_to: r.recorded_to ?? list[i + 1]?.recorded_from ?? null }));
  });
}

/** Fold raw chunk and business event rows into per-session outcomes (local mode, and tests). */
export function foldOutcomes(chunks: readonly RawChunkRow[], business: readonly BusinessEventRow[]): SessionOutcome[] {
  const by = new Map<string, SessionOutcome & { cart_at: number }>();
  for (const c of chunks) {
    let o = by.get(c.session_id);
    if (!o) {
      o = { session_id: c.session_id, routes: [], releases: [], first_seen: c.event_time_start, last_seen: c.event_time_end, sample_rate: c.sample_rate, cart_value_minor: null, currency: null, ordered: false, cart_at: -Infinity };
      by.set(c.session_id, o);
    }
    if (!o.routes.includes(c.route)) o.routes.push(c.route);
    if (!o.releases.includes(c.release)) o.releases.push(c.release);
    o.first_seen = Math.min(o.first_seen, c.event_time_start);
    o.last_seen = Math.max(o.last_seen, c.event_time_end);
    if (c.sample_rate !== null && (o.sample_rate === null || c.sample_rate < o.sample_rate)) o.sample_rate = c.sample_rate;
  }
  const cartNames = new Set<string>(CART_EVENT_NAMES);
  for (const b of business) {
    const o = by.get(b.session_id);
    if (!o) continue;
    if (b.name === ORDER_EVENT_NAME) o.ordered = true;
    if (cartNames.has(b.name) && b.value_minor !== null && b.event_time >= o.cart_at) {
      o.cart_at = b.event_time;
      o.cart_value_minor = b.value_minor;
      o.currency = b.currency;
    }
  }
  return [...by.values()].map(({ cart_at: _c, ...o }) => o);
}

/** Converts a BigQuery result row back to code types: TIMESTAMP -> epoch ms, INT64 -> number. */
export function fromBigQueryRow<T extends TableName>(table: T, row: Record<string, unknown>): RowTypes[T] {
  const out: Record<string, unknown> = {};
  for (const field of BQ_TABLES[table].fields) {
    const v = row[field.name];
    if (v === undefined || v === null) out[field.name] = null;
    else if (field.type === 'TIMESTAMP') out[field.name] = Date.parse(typeof v === 'object' && 'value' in v ? String((v as { value: unknown }).value) : String(v));
    else if (field.type === 'INT64') out[field.name] = Number(v);
    else if (field.type === 'JSON' && typeof v === 'string') out[field.name] = JSON.parse(v);
    else out[field.name] = v;
  }
  return out as RowTypes[T];
}

/** Most signals a read may return, whatever the caller asks. */
export const MAX_SIGNAL_ROWS = 500;
/** Cost guard on every API query (AGENTS rule: partition filter plus maximum bytes billed). */
const MAX_BYTES_BILLED = String(1_000_000_000);

export class BigQueryWarehouseReader implements WarehouseReader {
  constructor(
    private readonly bq: BigQuery,
    private readonly projectId: string,
    private readonly dataset: string,
  ) {}

  private table(name: string): string {
    return `\`${this.projectId}.${this.dataset}.${name}\``;
  }

  async signals(q: SignalQuery): Promise<SignalRow[]> {
    const [rows] = await this.bq.query({
      query: `SELECT * FROM ${this.table('signals_dedup')}
              WHERE tenant_id = @tenant AND event_time >= TIMESTAMP_MILLIS(@since)
              ${q.sessionId ? 'AND session_id = @session' : ''}
              ORDER BY event_time DESC LIMIT @limit`,
      params: { tenant: q.tenantId, since: Math.floor(q.sinceMs), limit: Math.min(q.limit, MAX_SIGNAL_ROWS), ...(q.sessionId ? { session: q.sessionId } : {}) },
      maximumBytesBilled: MAX_BYTES_BILLED,
      parseJSON: true,
    });
    return (rows as Record<string, unknown>[]).map((r) => fromBigQueryRow('signals', r));
  }

  async rawChunks(tenantId: string, sessionId: string, sinceMs: number): Promise<RawChunkRow[]> {
    const [rows] = await this.bq.query({
      query: `SELECT * EXCEPT (rn) FROM (
                SELECT *, ROW_NUMBER() OVER (PARTITION BY seq ORDER BY ingest_time) AS rn
                FROM ${this.table('raw_chunks')}
                WHERE tenant_id = @tenant AND session_id = @session AND event_time_start >= TIMESTAMP_MILLIS(@since)
              ) WHERE rn = 1 ORDER BY seq`,
      params: { tenant: tenantId, session: sessionId, since: Math.floor(sinceMs) },
      maximumBytesBilled: MAX_BYTES_BILLED,
    });
    return (rows as Record<string, unknown>[]).map((r) => fromBigQueryRow('raw_chunks', r));
  }

  async sessionOutcomes(tenantId: string, sinceMs: number): Promise<SessionOutcome[]> {
    const [rows] = await this.bq.query({
      query: `WITH chunks AS (
                SELECT session_id, ARRAY_AGG(DISTINCT route) AS routes, ARRAY_AGG(DISTINCT release) AS releases,
                       MIN(event_time_start) AS first_seen, MAX(event_time_end) AS last_seen, MIN(sample_rate) AS sample_rate
                FROM ${this.table('raw_chunks')}
                WHERE tenant_id = @tenant AND event_time_start >= TIMESTAMP_MILLIS(@since)
                GROUP BY session_id
              ), biz AS (
                SELECT session_id,
                       ARRAY_AGG(IF(name IN UNNEST(@cart_names) AND value_minor IS NOT NULL, STRUCT(value_minor, currency), NULL)
                                 IGNORE NULLS ORDER BY event_time DESC LIMIT 1)[SAFE_OFFSET(0)] AS cart,
                       LOGICAL_OR(name = @order_name) AS ordered
                FROM ${this.table('business_events')}
                WHERE tenant_id = @tenant AND event_time >= TIMESTAMP_MILLIS(@since)
                GROUP BY session_id
              )
              SELECT c.session_id, c.routes, c.releases, UNIX_MILLIS(c.first_seen) AS first_seen, UNIX_MILLIS(c.last_seen) AS last_seen,
                     c.sample_rate, b.cart.value_minor AS cart_value_minor, b.cart.currency AS currency, IFNULL(b.ordered, FALSE) AS ordered
              FROM chunks AS c LEFT JOIN biz AS b USING (session_id)
              LIMIT @max_rows`,
      params: { tenant: tenantId, since: Math.floor(sinceMs), cart_names: [...CART_EVENT_NAMES], order_name: ORDER_EVENT_NAME, max_rows: MAX_OUTCOME_ROWS },
      maximumBytesBilled: MAX_BYTES_BILLED,
    });
    return (rows as Record<string, unknown>[]).map((r) => ({
      session_id: String(r.session_id),
      routes: (r.routes as string[] | null) ?? [],
      releases: (r.releases as string[] | null) ?? [],
      first_seen: Number(r.first_seen),
      last_seen: Number(r.last_seen),
      sample_rate: r.sample_rate === null || r.sample_rate === undefined ? null : Number(r.sample_rate),
      cart_value_minor: r.cart_value_minor === null || r.cart_value_minor === undefined ? null : Number(r.cart_value_minor),
      currency: (r.currency as string | null | undefined) ?? null,
      ordered: r.ordered === true,
    }));
  }

  async findingVersions(tenantId: string, findingId: string, sinceMs: number): Promise<FindingRow[]> {
    const [rows] = await this.bq.query({
      query: `SELECT * FROM ${this.table('findings_versions')}
              WHERE tenant_id = @tenant AND finding_id = @finding AND valid_from >= TIMESTAMP_MILLIS(@since)
              ORDER BY recorded_from LIMIT 500`,
      params: { tenant: tenantId, finding: findingId, since: Math.floor(sinceMs) },
      maximumBytesBilled: MAX_BYTES_BILLED,
      parseJSON: true,
    });
    return (rows as Record<string, unknown>[]).map(versionRow);
  }

  async findingsTimeline(tenantId: string, sinceMs: number): Promise<FindingRow[]> {
    const [rows] = await this.bq.query({
      query: `SELECT * FROM ${this.table('findings_versions')}
              WHERE tenant_id = @tenant AND valid_from >= TIMESTAMP_MILLIS(@since)
              ORDER BY finding_id, recorded_from LIMIT 5000`,
      params: { tenant: tenantId, since: Math.floor(sinceMs) },
      maximumBytesBilled: MAX_BYTES_BILLED,
      parseJSON: true,
    });
    return (rows as Record<string, unknown>[]).map(versionRow);
  }

  async chunksInWindow(tenantId: string, fromMs: number, toMs: number, maxSessions: number): Promise<WindowChunks> {
    const [rows] = await this.bq.query({
      // One extra session tells whether the window held more than were asked for.
      query: `WITH sessions AS (
                SELECT session_id, MAX(event_time_end) AS last_seen
                FROM ${this.table('raw_chunks')}
                WHERE tenant_id = @tenant AND event_time_start >= TIMESTAMP_MILLIS(@from) AND event_time_start < TIMESTAMP_MILLIS(@to)
                GROUP BY session_id
                ORDER BY last_seen DESC
                LIMIT @limit
              )
              SELECT c.* FROM ${this.table('raw_chunks')} AS c JOIN sessions AS s USING (session_id)
              WHERE c.tenant_id = @tenant AND c.event_time_start >= TIMESTAMP_MILLIS(@from) AND c.event_time_start < TIMESTAMP_MILLIS(@to)`,
      params: { tenant: tenantId, from: Math.floor(fromMs), to: Math.ceil(toMs), limit: maxSessions + 1 },
      maximumBytesBilled: MAX_BYTES_BILLED,
    });
    return pickWindowSessions((rows as Record<string, unknown>[]).map((r) => fromBigQueryRow('raw_chunks', r)), maxSessions);
  }

  async findingsAsOf(q: AsOfQuery): Promise<FindingRow[]> {
    // The skill's as-of query (bitemporal-rescan). valid_from is not constant per finding (a re-scan can
    // move first_seen earlier), so the view's window cannot prune on it; the filter below bounds the scan.
    const [rows] = await this.bq.query({
      query: `SELECT * FROM ${this.table('findings_versions')}
              WHERE tenant_id = @tenant
                AND valid_from >= TIMESTAMP_MILLIS(@since)
                AND valid_from < TIMESTAMP_MILLIS(@valid_to)
                AND (valid_to IS NULL OR valid_to > TIMESTAMP_MILLIS(@valid_from))
                AND recorded_from <= TIMESTAMP_MILLIS(@as_of)
                AND (COALESCE(recorded_to, recorded_to_derived) IS NULL OR COALESCE(recorded_to, recorded_to_derived) > TIMESTAMP_MILLIS(@as_of))
              ORDER BY score DESC
              LIMIT @limit`,
      params: {
        tenant: q.tenantId,
        since: Math.floor(q.sinceMs),
        valid_from: Math.floor(q.validFrom),
        valid_to: Math.ceil(q.validTo),
        as_of: Math.floor(q.asOf),
        limit: MAX_ASOF_ROWS * 2,
      },
      maximumBytesBilled: MAX_BYTES_BILLED,
      parseJSON: true,
    });
    // A streaming retry can leave a duplicate version row; selectAsOf keeps one per finding.
    return selectAsOf((rows as Record<string, unknown>[]).map(versionRow), q);
  }
}

/** A findings_versions row with `recorded_to` taken from the view when the column is empty. */
function versionRow(r: Record<string, unknown>): FindingRow {
  const row = fromBigQueryRow('findings', r);
  const derived = r.recorded_to_derived;
  if (row.recorded_to === null && derived !== null && derived !== undefined) {
    row.recorded_to = Date.parse(typeof derived === 'object' && 'value' in derived ? String((derived as { value: unknown }).value) : String(derived));
  }
  return row;
}

export class LocalWarehouseReader implements WarehouseReader {
  constructor(private readonly store: LocalWarehouse) {}

  async signals(q: SignalQuery): Promise<SignalRow[]> {
    const seen = new Set<string>();
    return ((await this.store.rows('signals')) as unknown as (SignalRow & { _insert_id?: string })[])
      .filter((r) => r.tenant_id === q.tenantId && r.event_time >= q.sinceMs && (!q.sessionId || r.session_id === q.sessionId))
      .filter((r) => !seen.has(r.signal_id) && seen.add(r.signal_id))
      .sort((a, b) => b.event_time - a.event_time)
      .slice(0, Math.min(q.limit, MAX_SIGNAL_ROWS))
      .map(({ _insert_id: _id, ...row }) => row);
  }

  async rawChunks(tenantId: string, sessionId: string, sinceMs: number): Promise<RawChunkRow[]> {
    const bySeq = new Map<number, RawChunkRow>();
    for (const r of (await this.store.rows('raw_chunks')) as unknown as (RawChunkRow & { _insert_id?: string })[]) {
      if (r.tenant_id !== tenantId || r.session_id !== sessionId || r.event_time_start < sinceMs || bySeq.has(r.seq)) continue;
      const { _insert_id: _id, ...row } = r;
      bySeq.set(r.seq, row);
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  async sessionOutcomes(tenantId: string, sinceMs: number): Promise<SessionOutcome[]> {
    const chunks = ((await this.store.rows('raw_chunks')) as unknown as RawChunkRow[]).filter((r) => r.tenant_id === tenantId && r.event_time_start >= sinceMs);
    const business = ((await this.store.rows('business_events')) as unknown as BusinessEventRow[]).filter((r) => r.tenant_id === tenantId && r.event_time >= sinceMs);
    return foldOutcomes(chunks, business).slice(0, MAX_OUTCOME_ROWS);
  }

  async findingVersions(tenantId: string, findingId: string, sinceMs: number): Promise<FindingRow[]> {
    const rows = ((await this.store.rows('findings')) as unknown as (FindingRow & { _insert_id?: string })[])
      .filter((r) => r.tenant_id === tenantId && r.finding_id === findingId && r.valid_from >= sinceMs)
      .map(({ _insert_id: _id, ...row }) => row)
      .sort((a, b) => a.recorded_from - b.recorded_from);
    return rows.map((r, i) => ({ ...r, recorded_to: r.recorded_to ?? rows[i + 1]?.recorded_from ?? null }));
  }

  async findingsTimeline(tenantId: string, sinceMs: number): Promise<FindingRow[]> {
    const rows = ((await this.store.rows('findings')) as unknown as (FindingRow & { _insert_id?: string })[])
      .filter((r) => r.tenant_id === tenantId && r.valid_from >= sinceMs)
      .map(({ _insert_id: _id, ...row }) => row);
    return deriveRecordedTo(rows).sort((a, b) => (a.finding_id < b.finding_id ? -1 : a.finding_id > b.finding_id ? 1 : a.recorded_from - b.recorded_from));
  }

  async chunksInWindow(tenantId: string, fromMs: number, toMs: number, maxSessions: number): Promise<WindowChunks> {
    const rows = ((await this.store.rows('raw_chunks')) as unknown as (RawChunkRow & { _insert_id?: string })[])
      .filter((r) => r.tenant_id === tenantId && r.event_time_start >= fromMs && r.event_time_start < toMs)
      .map(({ _insert_id: _id, ...row }) => row);
    return pickWindowSessions(rows, maxSessions);
  }

  async findingsAsOf(q: AsOfQuery): Promise<FindingRow[]> {
    // Like the findings_versions view: close each version at the next one over the whole table, then filter.
    const rows = ((await this.store.rows('findings')) as unknown as (FindingRow & { _insert_id?: string })[])
      .filter((r) => r.tenant_id === q.tenantId)
      .map(({ _insert_id: _id, ...row }) => row);
    return selectAsOf(deriveRecordedTo(rows), q);
  }
}
