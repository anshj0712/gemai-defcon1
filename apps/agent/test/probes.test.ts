import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalBlobStore, LocalStateStore, LocalWarehouse, LocalWarehouseReader, type Publisher } from '@cp/platform';
import type { RecordedProbeSpec, RuleRow, SignalRow } from '@cp/schema';
import { SessionScript } from '@cp/testkit';
import { offlineRuleAuthor, singleProbeLimit } from '../src/llm/offline-rules.js';
import { OfflineLlm } from '../src/llm/offline.js';
import { createRuleService, probeSpecProblem, RuleError } from '../src/rules/service.js';
import { buildAgentServer } from '../src/server.js';
import { quiet, seedScript, T } from './helpers.js';

/**
 * Recorded probes (a selector read from the recorded page) and request probes (every finished call), end to
 * end through the rule service: preview, register, draft a rule over them, approve, and re-scan. All synthetic.
 */

/** rrweb serialized node types: document 0, element 2, text 3. */
const NodeType = { Document: 0, Element: 2, Text: 3 } as const;
const el = (id: number, tagName: string, attributes: Record<string, string> = {}, childNodes: unknown[] = []) => ({ type: NodeType.Element, id, tagName, attributes, childNodes });
const text = (id: number, textContent: string) => ({ type: NodeType.Text, id, textContent });

/** A checkout page: the delivery fee, a Place Order button, and the bank's authorisation call taking `bankMs`. */
function checkout(start: number, fee: string, bankMs: number): SessionScript {
  const doc = {
    type: NodeType.Document,
    id: 1,
    childNodes: [el(2, 'html', {}, [el(3, 'body', {}, [el(4, 'main', { id: 'checkout' }, [el(5, 'span', { id: 'delivery-fee' }, [text(6, fee)]), el(7, 'button', { id: 'place-order' }, [text(8, 'Place Order')])])])])],
  };
  return new SessionScript(start)
    .meta(0, 'http://localhost:5173/checkout')
    .snapshot(5, doc)
    .probe(20, { cart_total: [699_500] })
    .click(1000, 7)
    .net(1010, { phase: 'start', method: 'POST', route: '/api/payment/authorize' })
    .net(1010 + bankMs, { phase: 'end', method: 'POST', route: '/api/payment/authorize', status: 200, duration_ms: bankMs });
}

const FEE: RecordedProbeSpec = { name: 'shipping_fee', selector: '#delivery-fee', routes: ['/checkout'], kind: 'money' };
const NOOP_PUBLISHER: Publisher = { publish: async () => '1', close: async () => {} };

let blob: LocalBlobStore;
let warehouse: LocalWarehouse;
let state: LocalStateStore;
let clock: number;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-probes-'));
  blob = new LocalBlobStore(join(dir, 'gcs'), 'raw');
  warehouse = new LocalWarehouse(join(dir, 'bq'));
  state = new LocalStateStore(join(dir, 'firestore'));
  clock = T + 3_600_000;
  // A shocked shopper (₹499 delivery, slow bank) and two clean ones (free delivery, quick bank).
  await seedScript({ blob, warehouse }, 's_fee_shock_0001', checkout(T, '₹499', 6500), '/checkout');
  await seedScript({ blob, warehouse }, 's_clean_00000001', checkout(T + 60_000, 'Free', 250), '/checkout');
  await seedScript({ blob, warehouse }, 's_clean_00000002', checkout(T + 120_000, 'Free', 300), '/checkout');
});

const service = () =>
  createRuleService({
    state,
    warehouse,
    reader: new LocalWarehouseReader(warehouse),
    blob,
    publisher: NOOP_PUBLISHER,
    signalsTopic: 'signals',
    models: { bulk: new OfflineLlm(), reasoning: new OfflineLlm(), offline: true },
    logger: quiet,
    tenants: ['demo'],
    dryRun: { sessions: 100, days: 30 },
    rescan: { sessions: 100, days: 30, concurrency: 2 },
    revenue: { abandonAfterIdleMs: 120_000, minBaselineSessions: 1, minAffectedDecided: 1 },
    runOptions: { sleep: async () => {}, backoffMs: 1 },
    now: () => clock,
  });

describe('probe specs', () => {
  it('refuses reserved, taken and malformed probes', () => {
    expect(probeSpecProblem(FEE)).toBeNull();
    expect(probeSpecProblem({ ...FEE, name: 'req_post_x_ms' })).toMatch(/reserved/);
    expect(probeSpecProblem(FEE, new Set(['shipping_fee']))).toMatch(/already a probe/);
    expect(probeSpecProblem({ ...FEE, selector: 'li:nth-child(2)' })).toMatch(/supported subset/);
    expect(probeSpecProblem({ ...FEE, routes: ['checkout'] })).toMatch(/page paths/);
    expect(probeSpecProblem({ name: 'Bad Name', selector: '#x', kind: 'money' })).toMatch(/lowercase/);
  });
});

describe('the probe catalog and recorded probes', () => {
  it('lists every probe recent sessions report, by source', async () => {
    const { catalog, registry } = await service().listProbes('demo');
    const byName = Object.fromEntries(catalog.probes.map((p) => [p.name, p.source]));
    expect(byName).toEqual({ cart_total: 'declared', req_post_api_payment_authorize_ms: 'request', req_post_api_payment_authorize_status: 'request' });
    expect(registry).toEqual([]);
  });

  it('previews a recorded probe over recent sessions without saving it', async () => {
    const preview = await service().previewProbe('demo', FEE);
    expect(preview).toMatchObject({ sessions_scanned: 3, sessions_with_value: 1, values: { min: 49_900, max: 49_900 }, routes: ['/checkout'] });
    expect(preview.samples).toEqual([expect.objectContaining({ session_id: 's_fee_shock_0001', value: 49_900, route: '/checkout' })]);
    expect(await state.listProbes('demo')).toEqual([]);
  });

  it('registers a recorded probe that reads something, and refuses one that reads nothing', async () => {
    const rules = service();
    const doc = await rules.addProbe('demo', FEE, 'merchant@test');
    expect(doc).toMatchObject({ name: 'shipping_fee', status: 'active', version: 1, source: 'merchant', approved_by: 'merchant@test', preview: { sessions_with_value: 1 } });
    expect(await state.getProbe('demo', 'shipping_fee')).toEqual(doc);
    const rows = (await warehouse.rows('rules')) as unknown as RuleRow[];
    expect(rows).toEqual([expect.objectContaining({ rule_id: 'probe:shipping_fee', kind: 'probe', version: 1, created_by: 'merchant@test' })]);
    // Registering it again as it is changes nothing.
    expect(await rules.addProbe('demo', FEE, 'merchant@test')).toMatchObject({ version: 1 });
    await expect(rules.addProbe('demo', { ...FEE, name: 'nothing_here', selector: '#nope' }, 'm')).rejects.toMatchObject({ code: 'probe_reads_nothing', status: 422 });
    await expect(rules.addProbe('demo', { ...FEE, name: 'cart_total' }, 'm')).rejects.toMatchObject({ code: 'invalid_probe' });
    // Now the catalog reports it as recorded.
    const { catalog } = await rules.listProbes('demo');
    expect(catalog.probes.find((p) => p.name === 'shipping_fee')).toMatchObject({ source: 'recorded', min: 49_900, routes: ['/checkout'] });
  });

  it('drafts a merchant rule over a recorded probe, and the re-scan finds the shocked session', async () => {
    const rules = service();
    await rules.addProbe('demo', FEE, 'merchant@test');
    const doc = await rules.draft('demo', 'The shipping_fee must never be more than ₹0, because delivery is free.');
    expect(doc.draft!.rule).toMatchObject({ requires: ['shipping_fee'], assert: { op: 'lte', right: { const: 0 } } });
    expect(doc.draft!.dry_run).toMatchObject({ sessions_scanned: 3, sessions_applicable: 1, sessions_hit: 1 });
    expect(doc.draft!.proposed_probes).toBeUndefined();
    await rules.approve('demo', doc.rule_id, 1, 'merchant@test');
    await rules.idle();
    const signals = (await warehouse.rows('signals')) as unknown as SignalRow[];
    expect(signals.map((s) => s.session_id)).toEqual(['s_fee_shock_0001']);
    expect(signals[0]).toMatchObject({ detector: 'invariant_check', route: '/checkout' });
  });

  it('registers a proposed probe when its rule is approved, then re-scans with it', async () => {
    const rules = service();
    const doc = await rules.draft('demo', 'The shipping_fee must never be more than ₹0.', { origin: 'agent', cluster_id: null, suggester: { model: 'offline-stand-in', prompt_hash: 'h', offline: true, explanation: '', evidence_ids: [], assumptions: [], attempts: 1, ms: 1 }, proposedProbes: [FEE] });
    expect(doc.draft).toMatchObject({ origin: 'agent', cluster_id: null, proposed_probes: [FEE], dry_run: { sessions_hit: 1 } });
    expect(await state.getProbe('demo', 'shipping_fee')).toBeNull(); // nothing registered before approval
    await rules.approve('demo', doc.rule_id, 1, 'merchant@test');
    await rules.idle();
    expect(await state.getProbe('demo', 'shipping_fee')).toMatchObject({ status: 'active', source: 'agent', rule_id: doc.rule_id });
    const signals = (await warehouse.rows('signals')) as unknown as SignalRow[];
    expect(signals.map((s) => s.session_id)).toEqual(['s_fee_shock_0001']);
    // The probe the rule reads cannot be switched off while the rule is live.
    await expect(rules.disableProbe('demo', 'shipping_fee', 'm')).rejects.toBeInstanceOf(RuleError);
  });

  it('drafts a speed rule over a request probe', async () => {
    const doc = await service().draft('demo', 'req_post_api_payment_authorize_ms must never be more than 3 seconds');
    expect(doc.draft!.rule).toMatchObject({ requires: ['req_post_api_payment_authorize_ms'], assert: { op: 'lte', right: { const: 3000 } } });
    expect(doc.draft!.dry_run).toMatchObject({ sessions_applicable: 3, sessions_hit: 1, samples: [expect.objectContaining({ session_id: 's_fee_shock_0001', left: 6500, right: 3000 })] });
  });

  it('serves the probe routes', async () => {
    const app = buildAgentServer({ logger: quiet, runPass: async () => [], info: {}, rules: service() });
    const list = await app.inject({ method: 'GET', url: '/probes?tenant=demo' });
    expect(list.json().catalog.probes.length).toBe(3);
    const preview = await app.inject({ method: 'POST', url: '/probes/preview', payload: { tenant: 'demo', spec: FEE } });
    expect(preview.json().preview).toMatchObject({ sessions_with_value: 1 });
    expect((await app.inject({ method: 'POST', url: '/probes', payload: { tenant: 'demo', spec: { ...FEE, selector: 'a, b' } } })).statusCode).toBe(400);
    const added = await app.inject({ method: 'POST', url: '/probes', payload: { tenant: 'demo', spec: FEE, by: 'm' } });
    expect(added.json().probe).toMatchObject({ name: 'shipping_fee', status: 'active' });
    const off = await app.inject({ method: 'POST', url: '/probes/shipping_fee/disable', payload: { tenant: 'demo' } });
    expect(off.json().probe).toMatchObject({ status: 'disabled' });
  });
});

describe('the offline rule author: one probe, one limit', () => {
  const names = ['shipping_fee', 'req_post_api_payment_authorize_ms', 'delivery_days'];
  it('reads money, seconds and plain limits', () => {
    expect(singleProbeLimit('the shipping_fee must never be more than ₹0', names)).toEqual({ probe: 'shipping_fee', op: 'lte', value: 0, unit: 'money' });
    expect(singleProbeLimit('shipping_fee must be at most ₹1,499.50', names)).toEqual({ probe: 'shipping_fee', op: 'lte', value: 149_950, unit: 'money' });
    expect(singleProbeLimit('req_post_api_payment_authorize_ms must answer within 3 seconds', names)).toEqual({ probe: 'req_post_api_payment_authorize_ms', op: 'lte', value: 3000, unit: 'ms' });
    expect(singleProbeLimit('req_post_api_payment_authorize_ms never more than 2,500 ms', names)).toMatchObject({ value: 2500 });
    expect(singleProbeLimit('delivery_days must never be more than 5', names)).toEqual({ probe: 'delivery_days', op: 'lte', value: 5, unit: 'number' });
    expect(singleProbeLimit('delivery_days must be at least 1', names)).toMatchObject({ op: 'gte', value: 1 });
    expect(singleProbeLimit('shipping must be fast', names)).toBeNull();
  });

  it('writes the rule, citing the sentence and the probe', () => {
    const out = offlineRuleAuthor({ evidence: [{ id: 'S1', kind: 'sentence', text: 'delivery_days must never be more than 5' }, ...names.map((name, i) => ({ id: `P${i + 1}`, kind: 'probe', name }))] });
    expect(out).toMatchObject({ understood: true, rule_id: 'delivery_days_at_most_5', op: 'lte', highlight_probe: 'delivery_days', explanation: { evidence_ids: ['S1', 'P3'] } });
  });
});
