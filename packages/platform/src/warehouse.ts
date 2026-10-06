import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BigQuery } from '@google-cloud/bigquery';
import { BQ_TABLES, type RawChunkRow, type RowTypes, type SignalRow, type TableName } from '@cp/schema';

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

/** Read side of the warehouse, for the API. Every query is scoped to one tenant. */
export interface WarehouseReader {
  /** Newest first, one row per signal_id. */
  signals(q: SignalQuery): Promise<SignalRow[]>;
  /** A session's stored chunks in seq order, one row per seq. */
  rawChunks(tenantId: string, sessionId: string, sinceMs: number): Promise<RawChunkRow[]>;
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
}
