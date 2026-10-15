import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@cp/logger';
import { LocalStateStore } from '@cp/platform';
import type { SignalRow } from '@cp/schema';
import { applySignal, clusterKeyFor, LIMITS, titleFor } from '../src/cluster.js';
import { createClusterer } from '../src/handler.js';
import { buildClusterer } from '../src/server.js';

const T = 1_790_000_000_000;
const quiet = createLogger({ service: 'clusterer', format: 'json', level: 'silent', toCloud: false });
let n = 0;

const row = (over: Partial<SignalRow> = {}, values: Record<string, unknown> = {}): SignalRow => ({
  signal_id: `sig-${++n}`,
  tenant_id: 'demo',
  session_id: 's_session_0001',
  seq: 0,
  detector: 'dead_click',
  detector_version: '1.2.0',
  rule_version: 'p1',
  fingerprint: 'fp-dead',
  route: '/cart',
  element_selector: 'button#apply-coupon',
  release: 'demo-shop@local',
  evidence: { sessionId: over.session_id ?? 's_session_0001', seq: 0, tStart: T, tEnd: T + 800, values },
  event_time: T + n,
  ingest_time: T + 60_000,
  ...over,
});

const invariantRow = (over: Partial<SignalRow> = {}) =>
  row({ detector: 'invariant_check', element_selector: null, fingerprint: 'fp-inv', rule_version: 'cart_total_matches_lines@1', ...over }, {
    rule_id: 'cart_total_matches_lines',
    rule_title: "Cart total doesn't match its line items",
  });

describe('cluster keys', () => {
  it('puts every symptom of one broken button into one cluster', () => {
    const ids = ['dead_click', 'rage_click', 'response_decay', 'error_correlation'].map((detector) => clusterKeyFor(row({ detector, fingerprint: `fp-${detector}` })).cluster_id);
    expect(new Set(ids).size).toBe(1);
  });

  it('separates elements, routes, and tenants', () => {
    const base = clusterKeyFor(row()).cluster_id;
    expect(clusterKeyFor(row({ element_selector: 'button#checkout' })).cluster_id).not.toBe(base);
    expect(clusterKeyFor(row({ route: '/checkout' })).cluster_id).not.toBe(base);
    expect(clusterKeyFor(row({ tenant_id: 'acme' })).cluster_id).not.toBe(base);
  });

  it('groups invariant violations by rule, wherever they happen', () => {
    const a = clusterKeyFor(invariantRow());
    expect(a).toMatchObject({ kind: 'invariant', anchor: 'cart_total_matches_lines' });
    expect(clusterKeyFor(invariantRow({ route: '/checkout' })).cluster_id).toBe(a.cluster_id);
    // An error correlated with an invariant signal has no element, only the rule.
    expect(clusterKeyFor(row({ detector: 'error_correlation', element_selector: null }, { rule_id: 'cart_total_matches_lines' })).cluster_id).toBe(a.cluster_id);
  });
});

describe('applySignal', () => {
  it('counts symptoms, sessions, releases, and keeps the time span', () => {
    const key = clusterKeyFor(row());
    let c = applySignal(null, row({ event_time: T + 5000 }), key, T + 100);
    c = applySignal(c, row({ detector: 'rage_click', fingerprint: 'fp-rage', event_time: T + 1000 }), key, T + 200);
    c = applySignal(c, row({ session_id: 's_session_0002', release: 'r2', event_time: T + 9000 }), key, T + 300);
    expect(c).toMatchObject({
      kind: 'element',
      title: 'Unresponsive button#apply-coupon on /cart',
      detectors: { dead_click: 2, rage_click: 1 },
      signal_count: 3,
      session_count: 2,
      sessions: ['s_session_0001', 's_session_0002'],
      releases: { 'demo-shop@local': 2, r2: 1 },
      first_seen: T + 1000,
      last_seen: T + 9000,
      created_at: T + 100,
      updated_at: T + 300,
    });
    expect(c.fingerprints.sort()).toEqual(['fp-dead', 'fp-rage']);
  });

  it('keeps at most five evidence items, newest first, one per session when it can', () => {
    const key = clusterKeyFor(row());
    let c = applySignal(null, row({ event_time: T + 1 }), key, T);
    for (let i = 2; i <= 8; i++) c = applySignal(c, row({ session_id: `s_session_000${i}`, event_time: T + i }), key, T);
    c = applySignal(c, row({ session_id: 's_session_0008', event_time: T + 9 }), key, T);
    expect(c.evidence).toHaveLength(LIMITS.evidence);
    expect(c.evidence.map((e) => e.event_time)).toEqual([T + 9, T + 7, T + 6, T + 5, T + 4]);
    expect(new Set(c.evidence.map((e) => e.session_id)).size).toBe(5);
  });

  it('turns an unresponsive control into a failing one when errors are attached', () => {
    const key = clusterKeyFor(row({ route: '/checkout', element_selector: 'button#place-order' }));
    let c = applySignal(null, row({ detector: 'rage_click', route: '/checkout', element_selector: 'button#place-order' }), key, T);
    expect(c.title).toBe('Rage-clicked button#place-order on /checkout');
    c = applySignal(c, row({ detector: 'error_correlation', route: '/checkout', element_selector: 'button#place-order' }, { error_signature: 'HTTP 500 POST /api/checkout' }), key, T);
    expect(c.title).toBe('Failing button#place-order on /checkout');
    expect(c.error_signatures).toEqual({ 'HTTP 500 POST /api/checkout': 1 });
  });

  it('titles invariant clusters with their rule', () => {
    const c = applySignal(null, invariantRow(), clusterKeyFor(invariantRow()), T);
    expect(c.title).toBe("Cart total doesn't match its line items");
    expect(titleFor({ kind: 'invariant', anchor: 'x', route: '/', detectors: {}, error_signatures: {} })).toBe('Rule x violated');
  });

  it('counts sessions a re-scan brought in as found later, but not sessions already known live', () => {
    const key = clusterKeyFor(invariantRow());
    let c = applySignal(null, invariantRow({ session_id: 's_live_000001' }), key, T);
    expect(c.found_later).toBeUndefined();
    // The live session is hit again by the re-scan: still known at the time.
    c = applySignal(c, invariantRow({ session_id: 's_live_000001', rescan_id: 'rs_a' }), key, T);
    c = applySignal(c, invariantRow({ session_id: 's_past_000001', rescan_id: 'rs_a' }), key, T);
    c = applySignal(c, invariantRow({ session_id: 's_past_000002', rescan_id: 'rs_a' }), key, T);
    c = applySignal(c, invariantRow({ session_id: 's_past_000002', rescan_id: 'rs_a' }), key, T);
    expect(c.found_later).toEqual({ sessions: 2, rescans: { rs_a: 2 } });
    expect(c.session_count).toBe(3);
  });

  it('does not modify the cluster it is given', () => {
    const key = clusterKeyFor(row());
    const first = applySignal(null, row(), key, T);
    const copy = structuredClone(first);
    applySignal(first, row({ session_id: 's_session_0009' }), key, T);
    expect(first).toEqual(copy);
  });
});

describe('clusterer with the state store', () => {
  let state: LocalStateStore;
  beforeEach(() => {
    state = new LocalStateStore(mkdtempSync(join(tmpdir(), 'cp-clusterer-')));
  });
  const clusterer = (max = 500) => createClusterer({ state, logger: quiet, maxClustersPerTenant: max, markerTtlMs: 86_400_000, now: () => T });

  it('opens an issue, updates it, and ignores a redelivered signal', async () => {
    const c = clusterer();
    const first = row();
    expect(await c.apply(first)).toBe('created');
    expect(await c.apply(row({ session_id: 's_session_0002' }))).toBe('updated');
    expect(await c.apply(first)).toBe('duplicate');
    const [cluster] = await state.listClusters('demo', 10);
    expect(cluster).toMatchObject({ signal_count: 2, session_count: 2 });
  });

  it('counts every signal when many arrive at once for the same issue', async () => {
    const c = clusterer();
    await Promise.all(Array.from({ length: 20 }, (_, i) => c.apply(row({ session_id: `s_session_${String(i).padStart(4, '0')}` }))));
    const [cluster] = await state.listClusters('demo', 10);
    expect(cluster).toMatchObject({ signal_count: 20, session_count: 20 });
  });

  it('refuses new issues past the tenant cap but keeps updating existing ones', async () => {
    const c = clusterer(1);
    expect(await c.apply(row())).toBe('created');
    expect(await c.apply(row({ element_selector: 'button#checkout' }))).toBe('capped');
    expect(await c.apply(row())).toBe('updated');
    expect(await state.countClusters('demo')).toBe(1);
  });

  it('lists issues most recently active first, per tenant', async () => {
    const c = clusterer();
    await c.apply(row({ event_time: T + 10 }));
    await c.apply(invariantRow({ event_time: T + 20 }));
    await c.apply(row({ tenant_id: 'acme', event_time: T + 30 }));
    expect((await state.listClusters('demo', 10)).map((x) => x.kind)).toEqual(['invariant', 'element']);
    expect(await state.listClusters('acme', 10)).toHaveLength(1);
  });
});

describe('push endpoint', () => {
  const push = (data: unknown) => ({
    method: 'POST' as const,
    url: '/pubsub/push',
    payload: { message: { data: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)).toString('base64'), messageId: '1' }, subscription: 'projects/p/subscriptions/signals.clusterer' },
  });

  it('clusters a signal and acks with 204; acks poison; rejects non-push bodies', async () => {
    const state = new LocalStateStore(mkdtempSync(join(tmpdir(), 'cp-clusterer-')));
    const app = buildClusterer({ logger: quiet, handler: createClusterer({ state, logger: quiet, maxClustersPerTenant: 500, markerTtlMs: 1 }) });
    expect((await app.inject(push(row()))).statusCode).toBe(204);
    expect(await state.countClusters('demo')).toBe(1);
    expect((await app.inject(push('not json'))).statusCode).toBe(204);
    expect((await app.inject(push({ hello: 'world' }))).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/pubsub/push', payload: { nope: 1 } })).statusCode).toBe(400);
  });
});
