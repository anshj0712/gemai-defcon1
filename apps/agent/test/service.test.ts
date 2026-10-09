import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalBlobStore, LocalStateStore, LocalWarehouse, LocalWarehouseReader, type SessionOutcome } from '@cp/platform';
import type { Cluster, Finding, RawChunkRow, BusinessEventRow } from '@cp/schema';
import type { ModelSet } from '../src/llm/models.js';
import { OfflineLlm } from '../src/llm/offline.js';
import { toFindingRow } from '../src/pipeline.js';
import { DEFAULT_PRIORITY_RULES } from '../src/scoring/index.js';
import { createAgentService, dueClusters, recordRules, type ServiceDeps } from '../src/service.js';
import type { Screenshotter } from '../src/visual/screenshot.js';
import { demoClusters, quiet, RecordedLlm, T } from './helpers.js';

let dir: string;
let state: LocalStateStore;
let warehouse: LocalWarehouse;
let clock = T + 3_600_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-agent-'));
  state = new LocalStateStore(join(dir, 'firestore'));
  warehouse = new LocalWarehouse(join(dir, 'bq'));
  clock = T + 3_600_000;
});

/** Seed raw_chunks + business_events so the reader can fold session outcomes (synthetic). */
async function seedOutcomes(outcomes: SessionOutcome[]) {
  const chunks: RawChunkRow[] = outcomes.flatMap((o) =>
    o.routes.map((route, i) => ({
      tenant_id: 'demo', session_id: o.session_id, seq: i, gcs_uri: `local://x/${o.session_id}/${i}`, bytes: 1, event_count: 1,
      event_time_start: o.first_seen + i, event_time_end: o.last_seen, ingest_time: o.last_seen, client_sent_at: o.last_seen, collector_received_at: o.last_seen,
      release: o.releases[0]!, route, sdk_version: '0.1.0', sample_rate: o.sample_rate,
    })),
  );
  const biz: BusinessEventRow[] = outcomes.flatMap((o) => [
    { tenant_id: 'demo', session_id: o.session_id, seq: 0, name: 'cart_viewed', value_minor: o.cart_value_minor, currency: o.currency, event_time: o.first_seen + 10, ingest_time: o.last_seen },
    ...(o.ordered ? [{ tenant_id: 'demo', session_id: o.session_id, seq: 1, name: 'order_placed', value_minor: o.cart_value_minor, currency: o.currency, event_time: o.last_seen, ingest_time: o.last_seen }] : []),
  ]);
  await warehouse.insert('raw_chunks', chunks.map((row) => ({ insertId: `${row.session_id}:${row.seq}`, row })));
  await warehouse.insert('business_events', biz.map((row, i) => ({ insertId: `${row.session_id}:${row.name}:${i}`, row })));
}

async function putCluster(c: Cluster) {
  await state.applyToCluster(c.tenant_id, c.cluster_id, `seed-${c.cluster_id}-${c.signal_count}`, () => c, 1);
}

function deps(models: ModelSet, over: Partial<ServiceDeps> = {}): ServiceDeps {
  return {
    state,
    warehouse,
    reader: new LocalWarehouseReader(warehouse),
    blob: new LocalBlobStore(join(dir, 'gcs'), 'cp-raw'),
    models,
    rules: DEFAULT_PRIORITY_RULES,
    screenshotter: null,
    logger: quiet,
    tenants: ['demo'],
    rescoreMs: 10_000,
    maxPerPass: 5,
    lookbackMs: 7 * 86_400_000,
    regressionWindowMs: 86_400_000,
    revenue: { abandonAfterIdleMs: 120_000, minBaselineSessions: 5, minAffectedDecided: 3 },
    loadReplay: async () => null,
    runOptions: { sleep: async () => undefined },
    now: () => clock,
    ...over,
  };
}

const offline = (): ModelSet => {
  const m = new OfflineLlm();
  return { bulk: m, reasoning: m, offline: true };
};

async function seedDemo(only?: 'dead') {
  const { dead, total, checkout, ids } = demoClusters(10);
  for (const c of only ? [dead] : [dead, total, checkout]) await putCluster(c);
  const sessions = (p: string, abandon: number, routes: string[]) =>
    ids(p).map((s, i) => ({ session_id: s, routes, releases: ['demo-shop@local'], first_seen: T, last_seen: T + 60_000, sample_rate: 1, cart_value_minor: 1_000_000, currency: 'INR', ordered: i >= abandon }));
  await seedOutcomes([
    ...sessions('dead', 6, ['/', '/cart']),
    ...sessions('total', 4, ['/', '/cart']),
    ...sessions('checkout', 9, ['/', '/cart', '/checkout']),
    ...Array.from({ length: 40 }, (_, i) => ({ session_id: `s_clean_${String(i).padStart(4, '0')}`, routes: ['/', '/cart', '/checkout'], releases: ['demo-shop@local'], first_seen: T, last_seen: T + 60_000, sample_rate: 1, cart_value_minor: 1_000_000, currency: 'INR', ordered: i >= 10 })),
  ]);
  return { dead, total, checkout };
}

describe('agent service', () => {
  it('turns the three demo issues into ranked findings with one version row each (offline model, synthetic data)', async () => {
    const { dead, total, checkout } = await seedDemo();
    const service = createAgentService(deps(offline()));
    const [result] = await service.runPass();
    expect(result).toMatchObject({ clusters: 3, analyzed: 3, versions: 3, failed: 0 });

    const findings = await state.listFindings('demo', 10);
    const by = new Map(findings.map((f) => [f.finding_id, f]));
    expect(by.get(checkout.cluster_id)).toMatchObject({ tier: 'P0', status: 'open', revenue: { status: 'ok', abandonment_affected: 0.9, abandonment_baseline: 0.25 } });
    expect(by.get(total.cluster_id)).toMatchObject({ tier: 'P1', triage: { category: 'pricing_error' } });
    const d = by.get(dead.cluster_id)!;
    expect(d).toMatchObject({ tier: 'P2', version: 1, model_version: 'offline-stand-in', synthetic: true });
    // 10 sessions x ₹10,000 x (0.6 - 0.25) = ₹35,000 at risk; score = 35,000 x 0.5 (P2).
    expect(d.revenue.revenue_at_risk_minor).toBe(3_500_000);
    expect(d.score).toBe(17_500);
    expect(d.triage?.repro_steps.length).toBeGreaterThanOrEqual(2);
    expect(d.runs.map((r) => [r.agent, r.ok])).toEqual([['triage', true], ['root_cause', true], ['ranker', true]]);

    const rows = await warehouse.rows('findings');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ recorded_to: null, valid_to: null, details: expect.objectContaining({ synthetic: true }) });
    const rules = await warehouse.rows('rules');
    expect(rules).toHaveLength(0); // recorded by index.ts at startup, see the next test
  });

  it('records the priority rule set once per version', async () => {
    await recordRules(warehouse, ['demo'], DEFAULT_PRIORITY_RULES, clock);
    await recordRules(warehouse, ['demo'], DEFAULT_PRIORITY_RULES, clock + 1);
    expect(await warehouse.rows('rules')).toHaveLength(DEFAULT_PRIORITY_RULES.length);
  });

  it('caches the agents per issue nature: more sessions re-score without new model calls', async () => {
    const { dead } = await seedDemo('dead');
    const fixtures = new RecordedLlm({
      triage: [{ title: 'Coupon button dies', category: 'broken_control', confidence: 0.9, summary: { text: 's', evidence_ids: ['E1'] }, likely_cause: { text: 'c', evidence_ids: ['E2'] }, repro_steps: [{ step: 'a', evidence_ids: ['E1'] }, { step: 'b', evidence_ids: [] }] }],
      root_cause: [{ hypothesis: { text: 'h', evidence_ids: ['E2'] }, visual_check: 'not_checked', visual_notes: { text: 'n', evidence_ids: ['E1'] }, suggested_fix_area: 'handler' }],
      ranker: [{ rule_ids: ['checkout_friction'], tier_move: 'none', move_rule_id: '', reason: { text: 'r', evidence_ids: ['E1'] } }],
    });
    const service = createAgentService(deps({ bulk: fixtures, reasoning: fixtures, offline: false }));
    await service.runPass();
    expect(fixtures.calls('triage')).toBe(1);
    const first = (await state.getFinding('demo', dead.cluster_id))!;
    expect(first.title).toBe('Coupon button dies');

    // Nothing changed and not due yet: no work.
    clock += 1_000;
    expect((await service.runPass())[0]).toMatchObject({ analyzed: 0 });

    // The issue gains a session (same symptoms, no doubling): re-scored, new version, cached analysis.
    const grown = { ...dead, session_count: dead.session_count + 1, sessions: [...dead.sessions, 's_dead_new_0001'], signal_count: dead.signal_count + 1, updated_at: clock };
    await state.applyToCluster('demo', dead.cluster_id, 'grow-1', () => grown, 1);
    clock += 20_000;
    await service.runPass();
    const second = (await state.getFinding('demo', dead.cluster_id))!;
    expect(fixtures.calls('triage')).toBe(1);
    expect(second.version).toBe(2);
    expect(second.affected_sessions).toBe(dead.session_count + 1);
    expect(second.evidence).toEqual(first.evidence);

    // A new symptom changes the issue's nature: the agents run again.
    const changed = { ...grown, detectors: { ...grown.detectors, rage_click: 1 }, updated_at: clock };
    await state.applyToCluster('demo', dead.cluster_id, 'grow-2', () => changed, 1);
    clock += 20_000;
    await service.runPass();
    expect(fixtures.calls('triage')).toBe(2);

    // Doubling the sessions re-runs the analysis on the larger evidence.
    const doubled = { ...changed, session_count: 22, updated_at: clock };
    await state.applyToCluster('demo', dead.cluster_id, 'grow-3', () => doubled, 1);
    clock += 20_000;
    await service.runPass();
    expect(fixtures.calls('triage')).toBe(3);
  });

  it('marks a finding suspect when the visual check does not show the defect, and keeps the screenshot', async () => {
    const { dead } = await seedDemo('dead');
    const shots: string[] = [];
    const screenshotter: Screenshotter = {
      capture: async (_events, marker) => {
        shots.push(marker.signal_id);
        return { png: Buffer.from('89504e47', 'hex'), offsetMs: 4_200 };
      },
      close: async () => undefined,
    };
    const loadReplay = async (_t: string, session: string) => ({
      session: { session_id: session, tenant_id: 'demo', chunks: 1, release: 'r', route: '/cart', started_at: T, ended_at: T + 1 },
      events: [{ type: 4, timestamp: T }],
      markers: dead.evidence.filter((e) => e.session_id === session).map((e) => ({ signal_id: e.signal_id, detector: e.detector, label: 'x', replay_ts: T + 4_000, event_time: e.event_time, seq: 0, selector: e.selector, node_id: 9, fingerprint: 'f' })),
    });
    const fixtures = new RecordedLlm({
      triage: [{ title: 'Coupon button dies', category: 'broken_control', confidence: 0.9, summary: { text: 's', evidence_ids: ['E1'] }, likely_cause: { text: 'c', evidence_ids: ['E2'] }, repro_steps: [{ step: 'a', evidence_ids: ['E1'] }, { step: 'b', evidence_ids: [] }] }],
      root_cause: [{ hypothesis: { text: 'h', evidence_ids: ['E2'] }, visual_check: 'not_confirmed', visual_notes: { text: 'The coupon was applied on screen.', evidence_ids: ['E9'] }, suggested_fix_area: 'handler' }],
      ranker: [{ rule_ids: ['checkout_friction'], tier_move: 'none', move_rule_id: '', reason: { text: 'r', evidence_ids: ['E1'] } }],
    });
    const service = createAgentService(deps({ bulk: fixtures, reasoning: fixtures, offline: false }, { screenshotter, loadReplay }));
    await service.runPass();
    const f = (await state.getFinding('demo', dead.cluster_id)) as Finding;
    expect(shots).toEqual([dead.evidence[0]!.signal_id]);
    expect(f).toMatchObject({ status: 'suspect', screenshot: { evidence_id: 'E9', offset_ms: 4_200, uri: expect.stringContaining(`screenshots/demo/${dead.cluster_id}/`) } });
    expect(f.evidence.at(-1)).toMatchObject({ id: 'E9', kind: 'screenshot' });
    // The image went to the reasoning model with the root-cause turn.
    const rcReq = fixtures.requests.find((r) => r.config?.labels?.adk_agent_name === 'root_cause')!;
    expect(rcReq.contents[0]!.parts!.some((p) => p.inlineData?.mimeType === 'image/png')).toBe(true);
  });

  it('fails closed: an agent that keeps citing unknown evidence leaves the finding deterministic', async () => {
    const { dead } = await seedDemo('dead');
    const liar = new RecordedLlm({
      triage: [{ title: 'Made up', category: 'other', confidence: 1, summary: { text: 's', evidence_ids: ['E99'] }, likely_cause: { text: 'c', evidence_ids: ['E99'] }, repro_steps: [{ step: 'a', evidence_ids: ['E99'] }, { step: 'b', evidence_ids: [] }] }],
      root_cause: [{ hypothesis: { text: 'h', evidence_ids: ['E2'] }, visual_check: 'not_checked', visual_notes: { text: 'n', evidence_ids: ['E1'] }, suggested_fix_area: 'x' }],
      ranker: [{ rule_ids: ['checkout_friction'], tier_move: 'none', move_rule_id: '', reason: { text: 'r', evidence_ids: ['E1'] } }],
    });
    const service = createAgentService(deps({ bulk: liar, reasoning: liar, offline: false }));
    await service.runPass();
    const f = (await state.getFinding('demo', dead.cluster_id))!;
    expect(f.triage).toBeNull();
    expect(f.title).toBe(dead.title);
    expect(f.tier).toBe('P2');
    expect(f.runs[0]).toMatchObject({ agent: 'triage', ok: false, attempts: 2, error: expect.stringMatching(/E99/) });
  });

  it('picks new issues first, then the biggest', () => {
    const { dead, total, checkout } = demoClusters(3);
    const big = { ...total, session_count: 99 };
    const known = new Map([[checkout.cluster_id, { updated_at: 0 } as Finding]]);
    expect(dueClusters([dead, big, checkout], known, 100_000, 10_000, 2).map((c) => c.cluster_id)).toEqual([big.cluster_id, dead.cluster_id]);
  });

  it('writes bitemporal rows: valid time from the issue, transaction time from the pass', async () => {
    await seedDemo();
    await createAgentService(deps(offline())).runPass();
    const f = (await state.listFindings('demo', 1))[0]!;
    const row = toFindingRow(f, 42);
    expect(row).toMatchObject({ valid_from: f.first_seen, valid_to: null, recorded_from: 42, recorded_to: null, severity: f.tier, cluster_id: f.cluster_id, input_hash: f.input_hash });
    const versions = await new LocalWarehouseReader(warehouse).findingVersions('demo', f.finding_id, 0);
    expect(versions).toHaveLength(1);
  });
});
