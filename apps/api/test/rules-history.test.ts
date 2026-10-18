import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@cp/logger';
import { LocalBlobStore, LocalStateStore, LocalWarehouse, LocalWarehouseReader } from '@cp/platform';
import type { FindingRow, RuleDoc } from '@cp/schema';
import { historyMoments } from '../src/history.js';
import { buildApi } from '../src/server.js';

const T0 = 1_790_000_000_000;
const NOW = T0 + 10 * 3_600_000;
const quiet = createLogger({ service: 'api', format: 'json', level: 'silent', toCloud: false });

let dir: string;
let warehouse: LocalWarehouse;
let state: LocalStateStore;
let calls: { url: string; body: unknown }[];
let agentReply: { status: number; body: unknown } | Error;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-api-p4-'));
  warehouse = new LocalWarehouse(join(dir, 'bq'));
  state = new LocalStateStore(join(dir, 'firestore'));
  calls = [];
  agentReply = { status: 200, body: { rule: { rule_id: 'x' } } };
});

const fakeFetch: typeof fetch = async (input, init) => {
  calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? 'null')) });
  if (agentReply instanceof Error) throw agentReply;
  return new Response(JSON.stringify(agentReply.body), { status: agentReply.status, headers: { 'content-type': 'application/json' } });
};

const api = () =>
  buildApi({
    logger: quiet,
    reader: new LocalWarehouseReader(warehouse),
    blob: new LocalBlobStore(join(dir, 'gcs'), 'raw'),
    state,
    defaultTenant: 'demo',
    signalsLookbackMs: 365 * 86_400_000,
    replayLookbackMs: 31 * 86_400_000,
    maxReplayChunks: 1000,
    now: () => NOW,
    rules: { agentUrl: 'http://agent.test', fetchImpl: fakeFetch },
  });

const ruleDoc = (over: Partial<RuleDoc> = {}): RuleDoc => ({
  v: 1,
  tenant_id: 'demo',
  rule_id: 'bag_subtotal_per_pair_cap',
  title: 'Bag subtotal is more than ₹17,000 a pair',
  active: null,
  draft: null,
  rescan: null,
  versions: [],
  created_at: T0,
  updated_at: T0,
  synthetic: true,
  ...over,
});

describe('rules routes', () => {
  it('lists tenant rules with the built-ins, and serves one rule', async () => {
    await state.putRule(ruleDoc());
    const app = api();
    const list = (await app.inject({ url: '/v1/rules' })).json() as { rules: RuleDoc[]; builtin: { rule_id: string; text: string }[]; synthetic: boolean };
    expect(list.rules.map((r) => r.rule_id)).toEqual(['bag_subtotal_per_pair_cap']);
    expect(list.builtin[0]).toMatchObject({ rule_id: 'cart_total_matches_lines', text: 'cart_total = sum(line_total) − discount (within 1)' });
    expect(list.synthetic).toBe(true);
    expect(list.rules[0]).toMatchObject({ text: { active: null, draft: null } });
    expect((await app.inject({ url: '/v1/rules/bag_subtotal_per_pair_cap' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/rules/nope_rule' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/v1/rules/Bad-Id' })).statusCode).toBe(400);
  });

  it('forwards actions to the agent with the tenant, passing its status through', async () => {
    const app = api();
    const draft = await app.inject({ method: 'POST', url: '/v1/rules/draft', payload: { sentence: 'Discount at most 10%' } });
    expect(draft.statusCode).toBe(200);
    expect(calls[0]).toEqual({ url: 'http://agent.test/rules/draft', body: { tenant: 'demo', sentence: 'Discount at most 10%' } });

    agentReply = { status: 409, body: { error: 'conflict', message: 'stale draft' } };
    const approve = await app.inject({ method: 'POST', url: '/v1/rules/bag_subtotal_per_pair_cap/approve', payload: { version: 1 } });
    expect(approve.statusCode).toBe(409);
    expect(calls[1]).toEqual({ url: 'http://agent.test/rules/bag_subtotal_per_pair_cap/approve', body: { tenant: 'demo', version: 1, approved_by: 'dashboard' } });

    await app.inject({ method: 'POST', url: '/v1/rules/bag_subtotal_per_pair_cap/rescan?tenant=demo' });
    expect(calls[2]?.url).toBe('http://agent.test/rules/bag_subtotal_per_pair_cap/rescan');
    expect((await app.inject({ method: 'POST', url: '/v1/rules/draft', payload: {} })).statusCode).toBe(400);
  });

  it('forwards a reject note, a redraft, the probe actions, and a watch run', async () => {
    const app = api();
    await app.inject({ method: 'POST', url: '/v1/rules/fee_cap/reject', payload: { note: 'Express delivery is meant to cost ₹199' } });
    expect(calls[0]).toEqual({ url: 'http://agent.test/rules/fee_cap/reject', body: { tenant: 'demo', by: 'dashboard', note: 'Express delivery is meant to cost ₹199' } });
    await app.inject({ method: 'POST', url: '/v1/rules/fee_cap/reject' });
    expect(calls[1]?.body).toEqual({ tenant: 'demo', by: 'dashboard' });
    await app.inject({ method: 'POST', url: '/v1/rules/fee_cap/redraft', payload: { sentence: 'shipping_fee must never be more than ₹199' } });
    expect(calls[2]).toEqual({ url: 'http://agent.test/rules/fee_cap/redraft', body: { tenant: 'demo', sentence: 'shipping_fee must never be more than ₹199' } });

    agentReply = { status: 200, body: { catalog: { probes: [] }, registry: [] } };
    const list = await app.inject({ url: '/v1/probes' });
    expect(list.json()).toMatchObject({ registry: [], synthetic: true });
    expect(calls[3]).toEqual({ url: 'http://agent.test/probes?tenant=demo', body: null });
    const spec = { name: 'shipping_fee', selector: '#delivery-fee', kind: 'money' };
    await app.inject({ method: 'POST', url: '/v1/probes/preview', payload: { spec } });
    await app.inject({ method: 'POST', url: '/v1/probes', payload: { spec } });
    await app.inject({ method: 'POST', url: '/v1/probes/shipping_fee/disable' });
    expect(calls.slice(4).map((c) => [c.url, c.body])).toEqual([
      ['http://agent.test/probes/preview', { tenant: 'demo', spec }],
      ['http://agent.test/probes', { tenant: 'demo', spec, by: 'dashboard' }],
      ['http://agent.test/probes/shipping_fee/disable', { tenant: 'demo', by: 'dashboard' }],
    ]);
    expect((await app.inject({ method: 'POST', url: '/v1/probes/Bad-Name/disable' })).statusCode).toBe(400);
    await app.inject({ method: 'POST', url: '/v1/watch/run' });
    expect(calls.at(-1)).toEqual({ url: 'http://agent.test/watch/run', body: { tenant: 'demo' } });
  });

  it('answers 502 with a hint when the agent is down', async () => {
    agentReply = new Error('connect ECONNREFUSED');
    const res = await api().inject({ method: 'POST', url: '/v1/rules/draft', payload: { sentence: 'Discount at most 10%' } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'agent_unavailable' });
  });
});

describe('time travel', () => {
  const row = (id: string, recorded_from: number, over: Partial<FindingRow> = {}): FindingRow => ({
    tenant_id: 'demo',
    finding_id: id,
    fingerprint: id,
    severity: 'P1',
    revenue_at_risk_minor: 50_000,
    currency: 'INR',
    affected_sessions: 4,
    summary: 's',
    evidence_refs: {},
    rule_version: 'prs',
    model_version: 'offline-stand-in',
    prompt_hash: 'p',
    cluster_id: id,
    title: `Finding ${id}`,
    status: 'open',
    score: 10,
    input_hash: `${id}${recorded_from}`,
    details: { version: 1, revenue: { status: 'ok' }, kind: 'invariant', route: '/cart', discovery: { found_later: false, found_later_sessions: 0 } },
    valid_from: T0,
    valid_to: null,
    recorded_from,
    recorded_to: null,
    ...over,
  });

  it('compares what we knew at T with what we know now about the same window', async () => {
    const approvedAt = T0 + 3 * 3_600_000;
    await warehouse.insert('findings', [
      { insertId: 'a1', row: row('known', T0 + 600_000) },
      // Found by the re-scan after approval, about sessions from before it (valid_from T0 + 1 h).
      { insertId: 'b1', row: row('later', approvedAt + 120_000, { valid_from: T0 + 3_600_000, details: { version: 1, revenue: { status: 'ok' }, kind: 'invariant', route: '/cart', discovery: { found_later: true, found_later_sessions: 7 } } }) },
      // A bug that only started after T is new, not found later.
      { insertId: 'c1', row: row('new', NOW - 60_000, { valid_from: NOW - 120_000 }) },
    ]);
    await state.putRule(ruleDoc({ versions: [{ version: 1, approved_at: approvedAt }] }));

    const asOf = approvedAt - 1;
    const res = await api().inject({ url: `/v1/history?as_of=${asOf}&from=${T0 - 86_400_000}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { as_of: number; window: { from: number; to: number }; then: { finding_id: string }[]; current: { finding_id: string; found_later_sessions: number }[]; found_later: string[]; moments: { kind: string }[] };
    expect(body.window).toEqual({ from: T0 - 86_400_000, to: asOf });
    expect(body.then.map((f) => f.finding_id)).toEqual(['known']);
    expect(body.current.map((f) => f.finding_id).sort()).toEqual(['known', 'later']);
    expect(body.found_later).toEqual(['later']);
    expect(body.current.find((f) => f.finding_id === 'later')?.found_later_sessions).toBe(7);
    expect(body.moments).toEqual([expect.objectContaining({ kind: 'rule_approved', at: approvedAt })]);
  });

  it('answers the revenue charts in one call: each finding with its first hit, first known and versions', async () => {
    await warehouse.insert('findings', [
      { insertId: 't1', row: row('x', T0 + 600_000, { revenue_at_risk_minor: 10_000, valid_from: T0 + 300_000 }) },
      { insertId: 't2', row: row('x', T0 + 900_000, { revenue_at_risk_minor: 40_000, valid_from: T0 + 300_000 }) },
      { insertId: 't3', row: row('y', T0 + 700_000, { valid_from: T0 + 650_000 }) },
    ]);
    const res = await api().inject({ url: '/v1/history/timeline' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { findings: { finding_id: string; first_hit: number; first_known: number; versions: { revenue_at_risk_minor: number; recorded_to: number | null }[] }[] };
    const x = body.findings.find((f) => f.finding_id === 'x')!;
    expect(x.first_hit).toBe(T0 + 300_000);
    expect(x.first_known).toBe(T0 + 600_000);
    expect(x.versions.map((v) => v.revenue_at_risk_minor)).toEqual([10_000, 40_000]);
    expect(x.versions[0]?.recorded_to).toBe(T0 + 900_000);
    expect(x.versions[1]?.recorded_to).toBeNull();
    expect(body.findings.map((f) => f.finding_id).sort()).toEqual(['x', 'y']);
  });

  it('rejects an empty window', async () => {
    expect((await api().inject({ url: `/v1/history?from=${T0}&to=${T0}` })).statusCode).toBe(400);
  });

  it('turns approvals and finished re-scans into slider moments, in time order', () => {
    const moments = historyMoments([
      ruleDoc({
        versions: [{ version: 1, approved_at: 20 }],
        rescan: { rescan_id: 'rs', rule_version: 'x@1', status: 'done', window: { from: 0, to: 1 }, started_at: 20, finished_at: 30, sessions_total: 9, sessions_scanned: 9, sessions_failed: 0, chunks_scanned: 9, sessions_hit: 3, signals_written: 3, truncated: false, error: null },
      }),
    ]);
    expect(moments.map((m) => [m.kind, m.at])).toEqual([
      ['rule_approved', 20],
      ['rescan_done', 30],
    ]);
    expect(moments[1]?.label).toMatch(/3 sessions/);
  });
});
