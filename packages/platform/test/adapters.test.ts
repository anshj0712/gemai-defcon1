import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@cp/logger';
import type { SessionTail, SignalRow } from '@cp/schema';
import {
  ConfigError,
  LocalBlobStore,
  LocalPublisher,
  LocalStateStore,
  LocalWarehouse,
  loadPlatformConfig,
  toBigQueryRow,
} from '../src/index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'cp-platform-'));
const quiet = createLogger({ service: 'test', format: 'json', level: 'silent', toCloud: false });

describe('LocalBlobStore', () => {
  it('writes once and never overwrites', async () => {
    const store = new LocalBlobStore(tmp(), 'bucket');
    const first = await store.putIfAbsent('raw/t/s/00000001.json.gz', Buffer.from('first'));
    const second = await store.putIfAbsent('raw/t/s/00000001.json.gz', Buffer.from('second'));
    expect(first).toEqual({ uri: 'local://bucket/raw/t/s/00000001.json.gz', created: true });
    expect(second.created).toBe(false);
    expect((await store.get(first.uri)).toString()).toBe('first');
  });

  it('rejects paths that escape the bucket', async () => {
    const store = new LocalBlobStore(tmp(), 'bucket');
    await expect(store.putIfAbsent('raw/../../x', Buffer.from('x'))).rejects.toThrow(/unsafe/);
    await expect(store.get('local://bucket/../secrets')).rejects.toThrow(/unsafe/);
  });
});

describe('LocalWarehouse', () => {
  it('appends rows and deduplicates on insertId, also across restarts', async () => {
    const dir = tmp();
    const row = { name: 'cart_viewed' } as unknown as SignalRow;
    await new LocalWarehouse(dir).insert('signals', [{ insertId: 'a', row }, { insertId: 'b', row }]);
    const again = new LocalWarehouse(dir);
    await again.insert('signals', [{ insertId: 'a', row }, { insertId: 'c', row }]);
    expect((await again.rows('signals')).map((r) => r._insert_id)).toEqual(['a', 'b', 'c']);
  });
});

describe('toBigQueryRow', () => {
  it('converts timestamps and JSON, fills nulls, and drops unknown fields', () => {
    const out = toBigQueryRow('signals', {
      signal_id: 'x',
      evidence: { a: 1 },
      event_time: Date.UTC(2026, 8, 25, 10, 0, 0, 123),
      ingest_time: 0,
      element_selector: null,
      extra: 'dropped',
    });
    expect(out.event_time).toBe('2026-09-25T10:00:00.123Z');
    expect(out.evidence).toBe('{"a":1}');
    expect(out.element_selector).toBeNull();
    expect(out.tenant_id).toBeNull();
    expect(out).not.toHaveProperty('extra');
  });
});

describe('LocalStateStore', () => {
  it('round-trips tails and processed markers', async () => {
    const store = new LocalStateStore(tmp());
    const tail: SessionTail = { v: 1, tenant_id: 't', session_id: 's_state_test', last_seq: 3, horizon: 10, events: [], state: { nodes: {}, alias: {}, path: '/cart' }, updated_at: 1 };
    expect(await store.getTail('t', 's_state_test')).toBeNull();
    await store.putTail(tail);
    expect(await store.getTail('t', 's_state_test')).toEqual(tail);
    expect(await store.isProcessed('t', 's_state_test', 3)).toBe(false);
    await store.markProcessed('t', 's_state_test', 3);
    expect(await store.isProcessed('t', 's_state_test', 3)).toBe(true);
  });
});

describe('LocalPublisher', () => {
  let server: Server;
  let url = '';
  const received: { body: Record<string, unknown>; status: number }[] = [];
  let failNext = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const status = failNext > 0 ? 500 : 204;
        if (failNext > 0) failNext--;
        received.push({ body: JSON.parse(data) as Record<string, unknown>, status });
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/push`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('journals, then pushes in Pub/Sub push format, in order per key, retrying failures', async () => {
    const dir = tmp();
    const pub = new LocalPublisher({ dir, endpoints: { 'events.raw': url }, logger: quiet, baseDelayMs: 5 });
    failNext = 1;
    await pub.publish('events.raw', { seq: 0 }, { orderingKey: 's1', attributes: { seq: '0' } });
    await pub.publish('events.raw', { seq: 1 }, { orderingKey: 's1' });
    await pub.publish('signals', { x: 1 });
    await pub.close();

    const ok = received.filter((r) => r.status === 204);
    const decoded = ok.map((r) => JSON.parse(Buffer.from((r.body.message as { data: string }).data, 'base64').toString()) as { seq: number });
    expect(decoded.map((d) => d.seq)).toEqual([0, 1]);
    expect(received[0]?.status).toBe(500);
    expect(ok[0]?.body).toMatchObject({ subscription: 'projects/local/subscriptions/events.raw.local', deliveryAttempt: 2, message: { orderingKey: 's1', attributes: { seq: '0' } } });
    expect(readFileSync(join(dir, 'events.raw.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(readFileSync(join(dir, 'signals.jsonl'), 'utf8')).toContain('"x":1');
  });
});

describe('loadPlatformConfig', () => {
  it('defaults to local mode with a push endpoint for events.raw', () => {
    const c = loadPlatformConfig({});
    expect(c.mode).toBe('local');
    expect(c.localPushEndpoints).toEqual({ 'events.raw': 'http://localhost:8081/pubsub/push', signals: 'http://localhost:8083/pubsub/push' });
    expect(c.subscriptions).toEqual({ eventsRaw: 'events.raw.processor', signals: 'signals.clusterer' });
    expect(c.region).toBe('asia-south1');
  });

  it('requires a project id in gcp mode and treats empty values as unset', () => {
    expect(() => loadPlatformConfig({ CP_MODE: 'gcp', GCP_PROJECT_ID: '' })).toThrow(ConfigError);
    const c = loadPlatformConfig({ CP_MODE: 'gcp', GCP_PROJECT_ID: 'my-proj' });
    expect(c.rawBucket).toBe('my-proj-cp-raw');
  });

  it('reports malformed JSON settings clearly', () => {
    expect(() => loadPlatformConfig({ LOCAL_PUSH_ENDPOINTS: '{nope' })).toThrow(/LOCAL_PUSH_ENDPOINTS: must be JSON/);
  });
});
