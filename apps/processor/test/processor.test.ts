import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_RULES, DETECTORS } from '@cp/detectors';
import { createLogger } from '@cp/logger';
import { LocalBlobStore, LocalStateStore, LocalWarehouse, type Publisher, type PublishOptions, type Warehouse } from '@cp/platform';
import type { IngestEnvelope, InvariantRule, RawChunkMessage, StoredChunk } from '@cp/schema';
import { applyCouponScenario, SessionScript, toEnvelopes } from '@cp/testkit';
import { createChunkHandler, PoisonMessageError } from '../src/handle-chunk.js';
import { buildProcessor, deliver } from '../src/server.js';
import { TailCache } from '../src/tail-cache.js';

const T0 = 1_790_000_000_000;
const quiet = createLogger({ service: 'processor', format: 'json', level: 'silent', toCloud: false });

class RecordingPublisher implements Publisher {
  readonly messages: { topic: string; data: unknown; opts: PublishOptions }[] = [];
  async publish(topic: string, data: unknown, opts: PublishOptions = {}): Promise<string> {
    this.messages.push({ topic, data, opts });
    return String(this.messages.length);
  }
  async close(): Promise<void> {}
}

let dir: string;
let blob: LocalBlobStore;
let warehouse: LocalWarehouse;
let state: LocalStateStore;
let publisher: RecordingPublisher;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-processor-'));
  blob = new LocalBlobStore(join(dir, 'gcs'), 'raw');
  warehouse = new LocalWarehouse(join(dir, 'bq'));
  state = new LocalStateStore(join(dir, 'firestore'));
  publisher = new RecordingPublisher();
});

function handler(opts: { now?: () => number; warehouse?: Warehouse; state?: LocalStateStore; rulesFor?: (tenantId: string) => Promise<InvariantRule[] | undefined> } = {}) {
  const st = opts.state ?? state;
  return createChunkHandler({
    blob,
    warehouse: opts.warehouse ?? warehouse,
    publisher,
    state: st,
    tails: new TailCache(st, { ttlMs: 60_000, max: 100, storeTtlMs: 86_400_000 }),
    signalsTopic: 'signals',
    detectors: DETECTORS,
    overrides: {},
    lookbackMs: 10_000,
    tailMaxEvents: 2_000,
    markerTtlMs: 86_400_000,
    gapWaitAttempts: 4,
    logger: quiet,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.rulesFor ? { rulesFor: opts.rulesFor } : {}),
  });
}

/** Signal ids from processing the messages in order in a clean, separate environment. */
async function referenceSignalIds(messages: RawChunkMessage[]): Promise<string[]> {
  const refState = new LocalStateStore(join(dir, 'firestore-ref'));
  const refWarehouse = new LocalWarehouse(join(dir, 'bq-ref'));
  const h = createChunkHandler({
    blob,
    warehouse: refWarehouse,
    publisher: new RecordingPublisher(),
    state: refState,
    tails: new TailCache(refState, { ttlMs: 60_000, max: 100, storeTtlMs: 1 }),
    signalsTopic: 'signals',
    detectors: DETECTORS,
    overrides: {},
    lookbackMs: 10_000,
    tailMaxEvents: 2_000,
    markerTtlMs: 1,
    gapWaitAttempts: 4,
    logger: quiet,
  });
  for (const m of messages) await h.handle(m);
  return signalIds(await refWarehouse.rows('signals'));
}

const signalIds = (rows: Record<string, unknown>[]) => rows.map((r) => String(r.signal_id)).sort();

/** Ordered push: a message is redelivered (attempt + 1) until acked before the next one is sent. */
async function deliverInOrder(h: ReturnType<typeof handler>, messages: RawChunkMessage[]): Promise<number> {
  let nacks = 0;
  for (const m of messages) {
    for (let attempt = 1; ; attempt++) {
      const outcome = await deliver(h, Buffer.from(JSON.stringify(m)), { messageId: String(m.seq), deliveryAttempt: attempt }, quiet);
      if (outcome === 'ack') break;
      nacks++;
      if (attempt > 10) throw new Error('never acked');
    }
  }
  return nacks;
}

/** What the collector would have stored and published for an envelope. */
async function ingest(env: IngestEnvelope, receivedAt = env.client_sent_at + 40): Promise<RawChunkMessage> {
  const { site_key: _k, ...envelope } = env;
  const doc: StoredChunk = { v: 1, tenant_id: 'demo', collector_received_at: receivedAt, envelope };
  const body = gzipSync(JSON.stringify(doc));
  const { uri } = await blob.putIfAbsent(`raw/demo/${env.session_id}/${String(env.seq).padStart(8, '0')}.json.gz`, body, 'application/gzip');
  return {
    v: 1,
    tenant_id: 'demo',
    session_id: env.session_id,
    seq: env.seq,
    gcs_uri: uri,
    bytes: body.length,
    event_count: env.events.length,
    client_ts_start: env.client_ts_start,
    client_ts_end: env.client_ts_end,
    client_sent_at: env.client_sent_at,
    collector_received_at: receivedAt,
    release: env.release,
    route: env.page.route,
    sdk_version: env.sdk_version,
  };
}

function scenario(sessionId = 's_processor_test', opts: { clockOffsetMs?: number } = {}) {
  const s = applyCouponScenario({ start: T0, clicks: 7, respondFirst: 5 });
  return { ...s, envelopes: toEnvelopes(s.events, { sessionId, batchMs: 3000, end: s.end, ...opts }) };
}

describe('chunk handler', () => {
  it('turns the Apply Coupon session into one dead_click signal per unanswered click', async () => {
    const { envelopes, deadClickIndexes, clickTimes } = scenario();
    const h = handler();
    for (const env of envelopes) expect(await h.handle(await ingest(env))).toBe('processed');

    const signals = await warehouse.rows('signals');
    // Skew = collector_received_at - client_sent_at = +40 ms, applied to every valid time.
    expect(signals.map((s) => s.event_time)).toEqual(deadClickIndexes.map((i) => clickTimes[i]! + 40));
    expect(signals.every((s) => s.detector === 'dead_click' && s.element_selector === 'button#apply-coupon' && s.route === '/cart')).toBe(true);
    expect(new Set(signals.map((s) => s.fingerprint)).size).toBe(1);
    expect(signals[0]).toMatchObject({ tenant_id: 'demo', detector_version: '1.3.0', release: 'git:testkit' });

    expect(await warehouse.rows('raw_chunks')).toHaveLength(envelopes.length);
    expect(await warehouse.rows('business_events')).toMatchObject([{ name: 'cart_viewed', value_minor: 129900, currency: 'INR' }]);
    expect(publisher.messages.map((m) => m.topic)).toEqual(signals.map(() => 'signals'));
  });

  it('acks a redelivered chunk without writing anything twice', async () => {
    const { envelopes } = scenario();
    const h = handler();
    const messages = [];
    for (const env of envelopes) messages.push(await ingest(env));
    for (const m of messages) await h.handle(m);
    const before = (await warehouse.rows('signals')).length;

    for (const m of messages) expect(await h.handle(m)).toBe('duplicate');
    expect((await warehouse.rows('signals')).length).toBe(before);
    expect((await warehouse.rows('raw_chunks')).length).toBe(envelopes.length);
  });

  it('carries detector state across chunks, so response_decay sees a button that worked batches ago', async () => {
    const s = applyCouponScenario({ start: T0, clicks: 9, respondFirst: 5 });
    const envelopes = toEnvelopes(s.events, { sessionId: 's_decay_test_1', batchMs: 3000, end: s.end });
    expect(envelopes.length).toBeGreaterThan(3);
    const h = handler();
    for (const env of envelopes) await h.handle(await ingest(env));
    const decay = (await warehouse.rows('signals')).filter((r) => r.detector === 'response_decay');
    expect(decay).toHaveLength(1);
    expect(decay[0]).toMatchObject({ event_time: s.clickTimes[5]! + 40, element_selector: 'button#apply-coupon', route: '/cart' });
    expect((await state.getTail('demo', 's_decay_test_1'))?.detector_state).toHaveProperty('response_decay');
  });

  it("records invariant violations under the rule's own version", async () => {
    const script = new SessionScript(T0).meta(0).snapshot(5).probe(1000, { line_total: [1079500, 1659000], discount: [273850], cart_total: [2117615] });
    const [env] = toEnvelopes(script.events, { sessionId: 's_invariant_test_1', batchMs: 5000 });
    await handler().handle(await ingest(env!));
    const rows = (await warehouse.rows('signals')).filter((r) => r.detector === 'invariant_check');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rule_version: 'cart_total_matches_lines@1', route: '/cart', element_selector: null, detector_version: '1.0.0' });
  });

  it('applies the tenant rules it is given, so an approved rule flags live traffic', async () => {
    // Internally consistent totals (the built-in rule passes) but a line priced 100x: only the tenant rule fires.
    const script = new SessionScript(T0).meta(0).snapshot(5).probe(1000, { line_total: [139_900_000], qty: [2], discount: [0], cart_total: [139_900_000] });
    const [env] = toEnvelopes(script.events, { sessionId: 's_tenant_rule_1', batchMs: 5000 });
    const cap: InvariantRule = {
      id: 'bag_price_cap',
      version: 1,
      title: 'Bag costs more than the dearest pair per unit',
      requires: ['line_total', 'qty'],
      assert: { left: { sum: 'line_total' }, op: 'lte', right: { mul: [{ const: 1_700_000 }, { sum: 'qty' }] }, tolerance_minor: 0 },
    };
    await handler({ rulesFor: async () => [...BUILTIN_RULES, cap] }).handle(await ingest(env!));
    const rows = (await warehouse.rows('signals')).filter((r) => r.detector === 'invariant_check');
    expect(rows.map((r) => r.rule_version)).toEqual(['bag_price_cap@1']);
    expect(rows[0]).not.toHaveProperty('rescan_id');
  });

  it('keeps the valid time of a late-arriving chunk and stamps ingest time now', async () => {
    const { envelopes } = scenario();
    const twoDaysLater = T0 + 2 * 86_400_000;
    const h = handler({ now: () => twoDaysLater });
    for (const env of envelopes) await h.handle(await ingest(env));
    const [row] = await warehouse.rows('raw_chunks');
    expect(row).toMatchObject({ event_time_start: envelopes[0]!.client_ts_start + 40, ingest_time: twoDaysLater });
    const [signal] = await warehouse.rows('signals');
    expect(signal?.ingest_time).toBe(twoDaysLater);
    expect(Number(signal?.event_time)).toBeLessThan(T0 + 60_000);
  });

  it('corrects a browser clock that runs five minutes slow', async () => {
    const slow = -5 * 60_000;
    const { envelopes, deadClickIndexes, clickTimes } = scenario('s_slow_clock_1', { clockOffsetMs: slow });
    const h = handler();
    // The collector's clock is right: it receives each batch shortly after the true send time.
    for (const env of envelopes) await h.handle(await ingest(env, env.client_sent_at - slow + 40));
    const signals = await warehouse.rows('signals');
    expect(signals.map((s) => s.event_time)).toEqual(deadClickIndexes.map((i) => clickTimes[i]! + 40));
  });

  it('indexes but does not re-detect a chunk that arrives behind the session tail', async () => {
    const { envelopes } = scenario();
    const messages = [];
    for (const env of envelopes) messages.push(await ingest(env));
    for (const m of messages) await handler().handle(m);
    const signalsBefore = (await warehouse.rows('signals')).length;

    // A store that has the session tail but lost its processed markers: an out-of-order resend
    // of seq 1 must not be run through detection against a tail that has moved past it.
    const tail = await state.getTail('demo', 's_processor_test');
    const fresh = new LocalStateStore(join(dir, 'firestore-fresh'));
    await fresh.putTail(tail!);
    expect(await handler({ state: fresh }).handle(messages[1]!)).toBe('stale');
    expect((await warehouse.rows('signals')).length).toBe(signalsBefore);
    expect(await fresh.isProcessed('demo', 's_processor_test', 1)).toBe(true);
  });

  it('rejects a message whose chunk is missing as poison', async () => {
    const msg = await ingest(scenario().envelopes[0]!);
    await expect(handler().handle({ ...msg, gcs_uri: 'local://raw/raw/demo/s_processor_test/99999999.json.gz' })).rejects.toBeInstanceOf(PoisonMessageError);
  });

  it('rejects metadata that does not match the stored chunk as poison', async () => {
    const msg = await ingest(scenario().envelopes[0]!);
    await expect(handler().handle({ ...msg, session_id: 's_someone_else' })).rejects.toBeInstanceOf(PoisonMessageError);
  });

  it('retries cleanly after a transient warehouse failure', async () => {
    const { envelopes } = scenario();
    let failOnce = true;
    const flaky: Warehouse = {
      insert: async (table, rows) => {
        if (table === 'signals' && rows.length > 0 && failOnce) {
          failOnce = false;
          throw new Error('bigquery unavailable');
        }
        return warehouse.insert(table, rows);
      },
    };
    const messages = [];
    for (const env of envelopes) messages.push(await ingest(env));
    expect(await deliverInOrder(handler({ warehouse: flaky }), messages)).toBe(1);
    const reference = await referenceSignalIds(messages);
    expect(reference).toHaveLength(2);
    expect(signalIds(await warehouse.rows('signals'))).toEqual(reference);
    expect((await warehouse.rows('raw_chunks')).length).toBe(envelopes.length);
  });

  it('holds back a chunk that overtakes an earlier one until the earlier one lands', async () => {
    const { envelopes } = scenario();
    const messages = [];
    for (const env of envelopes) messages.push(await ingest(env));
    const h = handler();
    const [m0, m1, m2, ...rest] = messages;
    expect(await deliver(h, Buffer.from(JSON.stringify(m0)), { deliveryAttempt: 1 }, quiet)).toBe('ack');
    // seq 2 arrives before seq 1: sent back for redelivery.
    expect(await deliver(h, Buffer.from(JSON.stringify(m2)), { deliveryAttempt: 1 }, quiet)).toBe('nack');
    expect(await deliver(h, Buffer.from(JSON.stringify(m1)), { deliveryAttempt: 1 }, quiet)).toBe('ack');
    expect(await deliver(h, Buffer.from(JSON.stringify(m2)), { deliveryAttempt: 2 }, quiet)).toBe('ack');
    await deliverInOrder(h, rest);
    expect(signalIds(await warehouse.rows('signals'))).toEqual(await referenceSignalIds(messages));
  });

  it('stops waiting for a missing chunk after the configured attempts', async () => {
    const { envelopes } = scenario();
    const messages = [];
    for (const env of envelopes) messages.push(await ingest(env));
    const h = handler();
    await h.handle(messages[0]!);
    // seq 1 never arrives; seq 2 is processed on its 4th delivery.
    const m2 = Buffer.from(JSON.stringify(messages[2]));
    for (const attempt of [1, 2, 3]) expect(await deliver(h, m2, { deliveryAttempt: attempt }, quiet)).toBe('nack');
    expect(await deliver(h, m2, { deliveryAttempt: 4 }, quiet)).toBe('ack');
    expect(await state.isProcessed('demo', 's_processor_test', 2)).toBe(true);
  });
});

describe('push endpoint', () => {
  const push = (data: unknown, extra: Record<string, unknown> = {}) => ({
    method: 'POST' as const,
    url: '/pubsub/push',
    payload: {
      message: { data: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)).toString('base64'), messageId: '1', attributes: {} },
      subscription: 'projects/p/subscriptions/events.raw.processor',
      ...extra,
    },
  });

  it('acks a processed message with 204', async () => {
    const msg = await ingest(scenario().envelopes[0]!);
    const res = await buildProcessor({ logger: quiet, handler: handler() }).inject(push(msg));
    expect(res.statusCode).toBe(204);
  });

  it('acks poison messages so Pub/Sub stops redelivering them', async () => {
    const app = buildProcessor({ logger: quiet, handler: handler() });
    expect((await app.inject(push('not json'))).statusCode).toBe(204);
    expect((await app.inject(push({ v: 1, hello: 'world' }))).statusCode).toBe(204);
    const msg = await ingest(scenario().envelopes[0]!);
    expect((await app.inject(push({ ...msg, gcs_uri: 'local://raw/raw/demo/missing/00000009.json.gz' }))).statusCode).toBe(204);
  });

  it('returns 500 on a transient failure so Pub/Sub retries', async () => {
    const broken: Warehouse = { insert: async () => Promise.reject(new Error('down')) };
    const msg = await ingest(scenario().envelopes[0]!);
    const res = await buildProcessor({ logger: quiet, handler: handler({ warehouse: broken }) }).inject(push(msg));
    expect(res.statusCode).toBe(500);
  });

  it('rejects a body that is not a Pub/Sub push', async () => {
    const res = await buildProcessor({ logger: quiet, handler: handler() }).inject({ method: 'POST', url: '/pubsub/push', payload: { hello: 1 } });
    expect(res.statusCode).toBe(400);
  });
});
