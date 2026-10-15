import { describe, expect, it } from 'vitest';
import { applyCouponScenario, toEnvelopes } from '@cp/testkit';
import { BQ_TABLES, IngestEnvelope, RawChunkMessage, ROW_SCHEMAS, ruleText, StoredChunk, type TableName } from '../src/index.js';

const envelope = () => toEnvelopes(applyCouponScenario({ start: 1_790_000_000_000 }).events, { sessionId: 's_schema_test_1' })[0]!;

describe('IngestEnvelope', () => {
  it('accepts an SDK batch and keeps rrweb event fields', () => {
    const parsed = IngestEnvelope.parse(envelope());
    expect(parsed.events.length).toBeGreaterThan(0);
    expect(parsed.events[1]).toHaveProperty('data');
  });

  it('rejects session ids that could escape a storage path', () => {
    expect(IngestEnvelope.safeParse({ ...envelope(), session_id: '../../etc/passwd' }).success).toBe(false);
    expect(IngestEnvelope.safeParse({ ...envelope(), session_id: 'a/b/c/d/e/f' }).success).toBe(false);
  });

  it('rejects a batch that ends before it starts', () => {
    const e = envelope();
    expect(IngestEnvelope.safeParse({ ...e, client_ts_end: e.client_ts_start - 1 }).success).toBe(false);
  });

  it('drops unknown top-level keys', () => {
    const parsed = IngestEnvelope.parse({ ...envelope(), cookie: 'x' });
    expect(parsed).not.toHaveProperty('cookie');
  });

  it('defaults business_events to an empty list', () => {
    const { business_events: _b, ...rest } = envelope();
    expect(IngestEnvelope.parse(rest).business_events).toEqual([]);
  });
});

describe('StoredChunk', () => {
  it('has no site key', () => {
    const { site_key: _k, ...env } = envelope();
    const stored = StoredChunk.parse({ v: 1, tenant_id: 'demo', collector_received_at: 1, envelope: env });
    expect(stored.envelope).not.toHaveProperty('site_key');
  });
});

describe('RawChunkMessage', () => {
  it('carries metadata only', () => {
    const shape = Object.keys(RawChunkMessage.shape);
    expect(shape).not.toContain('events');
    expect(shape).toContain('gcs_uri');
  });
});

describe('BigQuery specs', () => {
  it.each(Object.keys(ROW_SCHEMAS) as TableName[])('%s: zod row and table columns match', (table) => {
    const zodKeys = Object.keys(ROW_SCHEMAS[table].shape).sort();
    const bqKeys = BQ_TABLES[table].fields.map((f) => f.name).sort();
    expect(bqKeys).toEqual(zodKeys);
  });

  it.each(Object.values(BQ_TABLES))('$name: partition and cluster columns exist', (spec) => {
    const names = spec.fields.map((f) => f.name);
    expect(names).toContain(spec.partitionField);
    expect(spec.fields.find((f) => f.name === spec.partitionField)?.type).toBe('TIMESTAMP');
    for (const c of spec.clusterFields) expect(names).toContain(c);
    expect(spec.clusterFields[0]).toBe('tenant_id');
  });

  it('signals carry the re-scan id as a nullable column', () => {
    expect(BQ_TABLES.signals.fields.find((f) => f.name === 'rescan_id')).toMatchObject({ type: 'STRING', mode: 'NULLABLE' });
  });

  it('every row table carries both clocks', () => {
    for (const t of ['signals', 'business_events'] as const) {
      const names = BQ_TABLES[t].fields.map((f) => f.name);
      expect(names).toEqual(expect.arrayContaining(['event_time', 'ingest_time']));
    }
    expect(BQ_TABLES.findings.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['valid_from', 'valid_to', 'recorded_from', 'recorded_to']));
  });
});

describe('ruleText', () => {
  it('reads a compiled rule back as one checkable line', () => {
    expect(ruleText({ assert: { left: { probe: 'cart_total' }, op: 'eq', right: { sub: [{ sum: 'line_total' }, { probe: 'discount', default: 0 }] }, tolerance_minor: 1 } })).toBe(
      'cart_total = sum(line_total) − discount (within 1)',
    );
    expect(
      ruleText({ assert: { left: { add: [{ sum: 'line_total' }, { mul: [{ const: -1 }, { probe: 'discount' }] }] }, op: 'lte', right: { mul: [{ const: 1700000 }, { sum: 'qty' }] }, tolerance_minor: 0 } }),
    ).toBe('sum(line_total) − discount ≤ 17,00,000 × sum(qty)');
  });
});
