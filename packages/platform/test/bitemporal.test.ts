import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FindingRow, RawChunkRow, RuleDoc } from '@cp/schema';
import { LocalStateStore, LocalWarehouse, LocalWarehouseReader, pickWindowSessions } from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'cp-bitemporal-'));

const finding = (id: string, recorded_from: number, over: Partial<FindingRow> = {}): FindingRow => ({
  tenant_id: 'demo',
  finding_id: id,
  fingerprint: id,
  severity: 'P1',
  revenue_at_risk_minor: 100,
  currency: 'INR',
  affected_sessions: 1,
  summary: 's',
  evidence_refs: {},
  rule_version: 'prs',
  model_version: 'm',
  prompt_hash: 'p',
  cluster_id: id,
  title: id,
  status: 'open',
  score: 1,
  input_hash: `${id}@${recorded_from}`,
  details: null,
  valid_from: 1_000,
  valid_to: null,
  recorded_from,
  recorded_to: null,
  ...over,
});

const chunk = (session: string, seq: number, start: number, over: Partial<RawChunkRow> = {}): RawChunkRow => ({
  tenant_id: 'demo',
  session_id: session,
  seq,
  gcs_uri: `local://b/raw/demo/${session}/${seq}`,
  bytes: 1,
  event_count: 1,
  event_time_start: start,
  event_time_end: start + 100,
  ingest_time: start + 200,
  client_sent_at: start,
  collector_received_at: start,
  release: 'r',
  route: '/cart',
  sdk_version: '1',
  sample_rate: 1,
  ...over,
});

describe('findingsAsOf (local reader)', () => {
  async function reader(rows: FindingRow[]) {
    const store = new LocalWarehouse(tmp());
    await store.insert('findings', rows.map((row, i) => ({ insertId: `i${i}`, row })));
    return new LocalWarehouseReader(store);
  }
  const window = { tenantId: 'demo', validFrom: 0, validTo: 10_000, sinceMs: 0 };

  it('answers what we believed at each moment, one version per finding', async () => {
    // A: v1 at 100, v2 at 200. B: first recorded at 300 about events since 500 (found later).
    const r = await reader([finding('a', 100, { severity: 'P2' }), finding('a', 200, { severity: 'P1' }), finding('b', 300, { valid_from: 500 })]);
    expect(await r.findingsAsOf({ ...window, asOf: 50 })).toEqual([]);
    expect((await r.findingsAsOf({ ...window, asOf: 150 })).map((f) => [f.finding_id, f.severity, f.recorded_to])).toEqual([['a', 'P2', 200]]);
    expect((await r.findingsAsOf({ ...window, asOf: 250 })).map((f) => [f.finding_id, f.severity])).toEqual([['a', 'P1']]);
    expect((await r.findingsAsOf({ ...window, asOf: 400 })).map((f) => f.finding_id).sort()).toEqual(['a', 'b']);
  });

  it('filters valid time by overlap with the window, and keeps one row when a version was stored twice', async () => {
    const r = await reader([finding('early', 100, { valid_from: 10, valid_to: 20 }), finding('late', 100, { valid_from: 5_000 }), finding('dup', 100), finding('dup', 100)]);
    const rows = await r.findingsAsOf({ tenantId: 'demo', validFrom: 30, validTo: 6_000, sinceMs: 0, asOf: 1_000 });
    expect(rows.map((f) => f.finding_id).sort()).toEqual(['dup', 'late']);
  });

  it('never returns another tenant', async () => {
    const r = await reader([finding('x', 100, { tenant_id: 'other' })]);
    expect(await r.findingsAsOf({ ...window, asOf: 1_000 })).toEqual([]);
  });
});

describe('chunksInWindow', () => {
  it('keeps the newest sessions, one row per seq in seq order, and reports truncation', () => {
    const picked = pickWindowSessions(
      [chunk('old', 0, 100), chunk('new', 1, 900), chunk('new', 0, 800), chunk('new', 0, 800, { ingest_time: 5 }), chunk('mid', 0, 500)],
      2,
    );
    expect(picked.sessions).toBe(2);
    expect(picked.truncated).toBe(true);
    expect(picked.chunks.map((c) => `${c.session_id}:${c.seq}`)).toEqual(['new:0', 'new:1', 'mid:0']);
    expect(picked.chunks[0]?.ingest_time).toBe(5);
  });

  it('reads only chunks that start inside the window (local reader)', async () => {
    const store = new LocalWarehouse(tmp());
    await store.insert('raw_chunks', [chunk('a', 0, 100), chunk('a', 1, 2_000), chunk('b', 0, 3_000, { tenant_id: 'other' })].map((row, i) => ({ insertId: `c${i}`, row })));
    const got = await new LocalWarehouseReader(store).chunksInWindow('demo', 0, 1_000, 10);
    expect(got).toMatchObject({ sessions: 1, truncated: false });
    expect(got.chunks.map((c) => c.seq)).toEqual([0]);
  });
});

describe('LocalStateStore rules', () => {
  const doc = (rule_id: string, updated_at: number, tenant_id = 'demo'): RuleDoc => ({
    v: 1,
    tenant_id,
    rule_id,
    title: rule_id,
    active: null,
    draft: null,
    rescan: null,
    versions: [],
    created_at: 1,
    updated_at,
    synthetic: true,
  });

  it('round-trips rule docs, newest first, per tenant', async () => {
    const store = new LocalStateStore(tmp());
    expect(await store.listRules('demo')).toEqual([]);
    await store.putRule(doc('a_rule', 10));
    await store.putRule(doc('b_rule', 20));
    await store.putRule(doc('c_rule', 30, 'other'));
    expect((await store.listRules('demo')).map((r) => r.rule_id)).toEqual(['b_rule', 'a_rule']);
    expect(await store.getRule('demo', 'a_rule')).toEqual(doc('a_rule', 10));
    expect(await store.getRule('demo', 'c_rule')).toBeNull();
  });
});
