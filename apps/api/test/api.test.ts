import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@cp/logger';
import { LocalBlobStore, LocalStateStore, LocalWarehouse, LocalWarehouseReader } from '@cp/platform';
import type { Cluster, RawChunkRow, SignalRow, StoredChunk } from '@cp/schema';
import { applyCouponScenario, toEnvelopes } from '@cp/testkit';
import { describe as caption, formatMoney, skewBySeq, stitchEvents, toMarkers } from '../src/replay.js';
import { buildApi } from '../src/server.js';

const T0 = 1_790_000_000_000;
const quiet = createLogger({ service: 'api', format: 'json', level: 'silent', toCloud: false });

let dir: string;
let blob: LocalBlobStore;
let warehouse: LocalWarehouse;
let state: LocalStateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-api-'));
  blob = new LocalBlobStore(join(dir, 'gcs'), 'raw');
  warehouse = new LocalWarehouse(join(dir, 'bq'));
  state = new LocalStateStore(join(dir, 'firestore'));
});

/** Store a session the way the collector and processor would, with a +250 ms clock skew. */
async function seedSession(sessionId: string, tenant = 'demo', skew = 250) {
  const scenario = applyCouponScenario({ start: T0, clicks: 7, respondFirst: 5 });
  const envelopes = toEnvelopes(scenario.events, { sessionId, batchMs: 3000, end: scenario.end });
  for (const env of envelopes) {
    const { site_key: _k, ...envelope } = env;
    const stored: StoredChunk = { v: 1, tenant_id: tenant, collector_received_at: env.client_sent_at + skew, envelope };
    const { uri } = await blob.putIfAbsent(`raw/${tenant}/${sessionId}/${String(env.seq).padStart(8, '0')}.json.gz`, gzipSync(JSON.stringify(stored)));
    const row: RawChunkRow = {
      tenant_id: tenant,
      session_id: sessionId,
      seq: env.seq,
      gcs_uri: uri,
      bytes: 1,
      event_count: env.events.length,
      event_time_start: env.client_ts_start + skew,
      event_time_end: env.client_ts_end + skew,
      ingest_time: T0 + 60_000,
      client_sent_at: env.client_sent_at,
      collector_received_at: env.client_sent_at + skew,
      release: env.release,
      route: env.page.route,
      sdk_version: env.sdk_version,
      sample_rate: 1,
    };
    await warehouse.insert('raw_chunks', [{ insertId: `${sessionId}:${env.seq}`, row }]);
  }
  // A dead_click on the 6th click, with valid time = browser time + skew (as the processor writes it).
  const click = scenario.clickTimes[5]!;
  const seq = envelopes.findIndex((e) => e.client_ts_start <= click && click < e.client_ts_end);
  const signal: SignalRow = {
    signal_id: `sig-${sessionId}`,
    tenant_id: tenant,
    session_id: sessionId,
    seq,
    detector: 'dead_click',
    detector_version: '1.1.0',
    rule_version: 'p1',
    fingerprint: 'fp1',
    route: '/cart',
    element_selector: 'button#apply-coupon',
    release: 'git:testkit',
    evidence: { sessionId, seq, tStart: click + skew, tEnd: click + skew + 800, selector: 'button#apply-coupon', values: { window_ms: 800, node_id: 9 } },
    event_time: click + skew,
    ingest_time: T0 + 60_000,
  };
  await warehouse.insert('signals', [{ insertId: signal.signal_id, row: signal }]);
  return { envelopes, click };
}

const api = () =>
  buildApi({
    logger: quiet,
    reader: new LocalWarehouseReader(warehouse),
    blob,
    state,
    defaultTenant: 'demo',
    signalsLookbackMs: 365 * 86_400_000,
    replayLookbackMs: 365 * 86_400_000,
    maxReplayChunks: 1000,
    now: () => T0 + 120_000,
  });

describe('replay helpers', () => {
  it('stitches chunks in seq order, once per seq, keeping timestamps ordered', () => {
    const envs = toEnvelopes(applyCouponScenario({ start: T0 }).events, { sessionId: 's_stitch_test', batchMs: 3000 });
    const chunks = envs.map((e) => ({ seq: e.seq, stored: { v: 1 as const, tenant_id: 'demo', collector_received_at: 0, envelope: e } }));
    const events = stitchEvents([...chunks].reverse().concat(chunks[0]!));
    expect(events).toHaveLength(envs.reduce((n, e) => n + e.events.length, 0));
    expect(events.map((e) => e.timestamp)).toEqual([...events.map((e) => e.timestamp)].sort((a, b) => a - b));
  });

  it('undoes the chunk skew to place a signal on the replay clock', () => {
    const skew = skewBySeq([{ seq: 2, collector_received_at: 10_250, client_sent_at: 10_000 } as RawChunkRow]);
    const [marker] = toMarkers(
      [{ signal_id: 's', detector: 'dead_click', seq: 2, element_selector: 'button#x', event_time: 5_250, fingerprint: 'f', evidence: { seq: 2, tStart: 5_250, values: { window_ms: 800, node_id: 7 } } } as unknown as SignalRow],
      skew,
    );
    expect(marker).toMatchObject({ replay_ts: 5_000, node_id: 7, label: 'Dead click on button#x: no response within 800 ms' });
  });
});

describe('GET /v1/sessions/:id/replay', () => {
  it('returns the stitched session with the flag on the browser clock', async () => {
    const { envelopes, click } = await seedSession('s_replay_api_1');
    const res = await api().inject({ method: 'GET', url: '/v1/sessions/s_replay_api_1/replay' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as { session: { chunks: number }; events: { type: number; timestamp: number }[]; markers: { replay_ts: number; node_id: number; selector: string }[] };
    expect(body.session.chunks).toBe(envelopes.length);
    expect(body.events.some((e) => e.type === 2)).toBe(true);
    expect(body.markers).toEqual([expect.objectContaining({ replay_ts: click, node_id: 9, selector: 'button#apply-coupon' })]);
    expect(body.events.some((e) => e.timestamp === click)).toBe(true);
  });

  it('never serves another tenant’s session', async () => {
    await seedSession('s_replay_other_1', 'acme');
    expect((await api().inject({ method: 'GET', url: '/v1/sessions/s_replay_other_1/replay?tenant=demo' })).statusCode).toBe(404);
    expect((await api().inject({ method: 'GET', url: '/v1/sessions/s_replay_other_1/replay?tenant=acme' })).statusCode).toBe(200);
  });

  it('404s an unknown session and 400s a malformed id', async () => {
    expect((await api().inject({ method: 'GET', url: '/v1/sessions/s_nobody_here/replay' })).statusCode).toBe(404);
    expect((await api().inject({ method: 'GET', url: '/v1/sessions/..%2F..%2Fetc/replay' })).statusCode).toBe(400);
  });
});

describe('GET /v1/signals', () => {
  it('lists the tenant’s signals newest first, marked synthetic', async () => {
    await seedSession('s_signals_api_1');
    await seedSession('s_signals_api_2', 'acme');
    const body = (await api().inject({ method: 'GET', url: '/v1/signals' })).json() as { tenant: string; synthetic: boolean; signals: SignalRow[] };
    expect(body).toMatchObject({ tenant: 'demo', synthetic: true });
    expect(body.signals.map((s) => s.session_id)).toEqual(['s_signals_api_1']);
  });
});

const cluster = (over: Partial<Cluster> = {}): Cluster => ({
  v: 1,
  tenant_id: 'demo',
  cluster_id: 'aaaaaaaaaaaaaaaaaaaa',
  kind: 'element',
  title: 'Unresponsive button#apply-coupon on /cart',
  route: '/cart',
  anchor: 'button#apply-coupon',
  detectors: { dead_click: 3, response_decay: 1 },
  signal_count: 4,
  session_count: 2,
  sessions: ['s_session_0001', 's_session_0002'],
  releases: { 'demo-shop@local': 4 },
  fingerprints: ['fp'],
  error_signatures: {},
  first_seen: T0,
  last_seen: T0 + 1000,
  created_at: T0,
  updated_at: T0,
  evidence: [],
  ...over,
});

describe('GET /v1/clusters', () => {
  it('lists the tenant’s issues most recently active first, without session lists', async () => {
    await state.applyToCluster('demo', 'aaaaaaaaaaaaaaaaaaaa', 'sig-a', () => cluster(), 1);
    await state.applyToCluster('demo', 'bbbbbbbbbbbbbbbbbbbb', 'sig-b', () => cluster({ cluster_id: 'bbbbbbbbbbbbbbbbbbbb', kind: 'invariant', last_seen: T0 + 5000 }), 1);
    await state.applyToCluster('acme', 'cccccccccccccccccccc', 'sig-c', () => cluster({ tenant_id: 'acme', cluster_id: 'cccccccccccccccccccc' }), 1);
    const res = await api().inject({ method: 'GET', url: '/v1/clusters' });
    const body = res.json() as { tenant: string; synthetic: boolean; clusters: Cluster[] };
    expect(body).toMatchObject({ tenant: 'demo', synthetic: true });
    expect(body.clusters.map((c) => c.cluster_id)).toEqual(['bbbbbbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaaaaaa']);
    expect(body.clusters[0]).not.toHaveProperty('sessions');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns one issue with its sessions, newest first; 404s other tenants and unknown ids; 400s bad ids', async () => {
    await state.applyToCluster('demo', 'aaaaaaaaaaaaaaaaaaaa', 'sig-a', () => cluster(), 1);
    const ok = await api().inject({ method: 'GET', url: '/v1/clusters/aaaaaaaaaaaaaaaaaaaa' });
    expect((ok.json() as { cluster: Cluster }).cluster.sessions).toEqual(['s_session_0002', 's_session_0001']);
    const one = await api().inject({ method: 'GET', url: '/v1/clusters/aaaaaaaaaaaaaaaaaaaa?sessions=1' });
    expect((one.json() as { cluster: Cluster }).cluster.sessions).toEqual(['s_session_0002']);
    expect((await api().inject({ method: 'GET', url: '/v1/clusters/aaaaaaaaaaaaaaaaaaaa?sessions=99999' })).statusCode).toBe(400);
    expect((await api().inject({ method: 'GET', url: '/v1/clusters/aaaaaaaaaaaaaaaaaaaa?tenant=acme' })).statusCode).toBe(404);
    expect((await api().inject({ method: 'GET', url: '/v1/clusters/ffffffffffffffffffff' })).statusCode).toBe(404);
    expect((await api().inject({ method: 'GET', url: '/v1/clusters/not-a-cluster-id' })).statusCode).toBe(400);
    expect((await api().inject({ method: 'GET', url: '/v1/clusters/..%2F..%2Fsecret' })).statusCode).toBe(400);
  });
});

describe('replay captions', () => {
  const sig = (detector: string, values: Record<string, unknown>, selector: string | null = 'button#place-order') =>
    ({ detector, element_selector: selector, evidence: { values } }) as unknown as SignalRow;

  it.each([
    [sig('rage_click', { clicks: 4, span_ms: 1200, failed: 2 }), 'Rage clicks on button#place-order: 4 clicks in 1.2 s, 2 failed'],
    [sig('response_decay', { answered_before: 5 }, 'button#apply-coupon'), 'button#apply-coupon stopped responding after working 5 times'],
    [sig('error_correlation', { error_signature: 'HTTP 500 POST /api/checkout', correlated_detector: 'rage_click' }), 'HTTP 500 POST /api/checkout right before the rage click on button#place-order'],
  ])('%#', (signal, text) => {
    expect(caption(signal)).toBe(text);
  });

  it('formats invariant amounts as money', () => {
    const text = caption(sig('invariant_check', { rule_title: "Cart total doesn't match its line items", actual: 2117615, expected: 2464650, currency: 'INR' }, null));
    expect(text).toBe("Cart total doesn't match its line items: shows " + formatMoney(2117615, 'INR') + ', expected ' + formatMoney(2464650, 'INR'));
    expect(formatMoney(2117615, 'INR')).toContain('21,176.15');
  });

  it('outlines the probe element for invariant markers', () => {
    const [marker] = toMarkers([{ ...sig('invariant_check', { highlight_probe: 'cart_total' }, null), signal_id: 's', seq: 0, event_time: 5, fingerprint: 'f', evidence: { seq: 0, tStart: 5, values: { highlight_probe: 'cart_total' } } } as unknown as SignalRow], new Map());
    expect(marker?.selector).toBe('[data-cp-probe="cart_total"]');
  });
});
