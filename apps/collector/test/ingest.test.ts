import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@cp/logger';
import { LocalBlobStore, type Publisher, type PublishOptions } from '@cp/platform';
import { RawChunkMessage, StoredChunk, type IngestEnvelope } from '@cp/schema';
import { applyCouponScenario, piiEnvelope, toEnvelopes } from '@cp/testkit';
import { toSiteKeyMap } from '../src/config.js';
import { buildCollector, chunkPath } from '../src/server.js';

const T0 = 1_790_000_000_000;
const quiet = createLogger({ service: 'collector', format: 'json', level: 'silent', toCloud: false });

class RecordingPublisher implements Publisher {
  readonly messages: { topic: string; data: unknown; opts: PublishOptions }[] = [];
  fail = false;
  async publish(topic: string, data: unknown, opts: PublishOptions = {}): Promise<string> {
    if (this.fail) throw new Error('pubsub down');
    this.messages.push({ topic, data, opts });
    return String(this.messages.length);
  }
  async close(): Promise<void> {}
}

let dir: string;
let blob: LocalBlobStore;
let publisher: RecordingPublisher;

async function app(overrides: { maxDecompressedBytes?: number; siteKeys?: Parameters<typeof toSiteKeyMap>[0] } = {}) {
  return buildCollector({
    logger: quiet,
    blob,
    publisher,
    topic: 'events.raw',
    siteKeys: toSiteKeyMap(overrides.siteKeys ?? { pk_local_demo: 'demo' }),
    maxBodyBytes: 1_000_000,
    maxDecompressedBytes: overrides.maxDecompressedBytes ?? 10_000_000,
    now: () => T0 + 60_000,
  });
}

const envelope = (): IngestEnvelope => toEnvelopes(applyCouponScenario({ start: T0 }).events, { sessionId: 's_ingest_test_1' })[0]!;
const post = (payload: string | Buffer, headers: Record<string, string> = {}) => ({
  method: 'POST' as const,
  url: '/v1/ingest',
  payload,
  headers: { 'content-type': 'application/json', ...headers },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-collector-'));
  blob = new LocalBlobStore(dir, 'raw-bucket');
  publisher = new RecordingPublisher();
});

describe('POST /v1/ingest', () => {
  it('stores the scrubbed batch and publishes metadata only', async () => {
    const res = await (await app()).inject(post(JSON.stringify(envelope())));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true, seq: 0, duplicate: false });

    const stored = StoredChunk.parse(JSON.parse(gunzipSync(await blob.get(blob.uriFor(chunkPath('demo', 's_ingest_test_1', 0)))).toString()));
    expect(stored).toMatchObject({ v: 1, tenant_id: 'demo', collector_received_at: T0 + 60_000 });
    expect(stored.envelope).not.toHaveProperty('site_key');

    const [msg] = publisher.messages;
    expect(msg?.topic).toBe('events.raw');
    expect(msg?.opts).toMatchObject({ orderingKey: 's_ingest_test_1', attributes: { tenant_id: 'demo', seq: '0' } });
    const data = RawChunkMessage.parse(msg?.data);
    expect(data).toMatchObject({ tenant_id: 'demo', seq: 0, gcs_uri: 'local://raw-bucket/raw/demo/s_ingest_test_1/00000000.json.gz', collector_received_at: T0 + 60_000 });
    expect(JSON.stringify(msg?.data)).not.toContain('"events"');
  });

  it('accepts gzip bodies, with or without Content-Encoding, and any content type', async () => {
    const body = gzipSync(JSON.stringify(envelope()));
    const a = await app();
    expect((await a.inject(post(body, { 'content-encoding': 'gzip' }))).statusCode).toBe(202);
    const other = { ...envelope(), seq: 1 };
    expect((await a.inject(post(gzipSync(JSON.stringify(other)), { 'content-type': 'text/plain' }))).statusCode).toBe(202);
  });

  it('stores exactly once when the same batch is delivered twice, and still republishes', async () => {
    const a = await app();
    const body = JSON.stringify(envelope());
    const first = await a.inject(post(body));
    const file = join(dir, 'raw-bucket', 'raw', 'demo', 's_ingest_test_1', '00000000.json.gz');
    const before = statSync(file).mtimeMs;
    const second = await a.inject(post(body));
    expect(first.json()).toMatchObject({ duplicate: false });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ duplicate: true });
    expect(statSync(file).mtimeMs).toBe(before);
    expect(publisher.messages).toHaveLength(2);
  });

  it('scrubs PII before storing', async () => {
    const res = await (await app()).inject(post(JSON.stringify(piiEnvelope(T0))));
    expect(res.statusCode).toBe(202);
    const raw = gunzipSync(await blob.get(blob.uriFor(chunkPath('demo', 's_pii_fixture_01', 0)))).toString();
    for (const secret of ['asha.rao@example.com', '4111 1111 1111 1111', 'secret-hidden-token', 'token=abc123', '9876543210']) {
      expect(raw).not.toContain(secret);
    }
  });

  it.each([
    ['empty body', '', 400, 'empty_body'],
    ['not JSON', '{nope', 400, 'invalid_json'],
    ['not an envelope', JSON.stringify({ hello: 'world' }), 400, 'invalid_envelope'],
    ['bad gzip', Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01]), 400, 'bad_gzip'],
  ])('rejects %s', async (_name, payload, status, error) => {
    const res = await (await app()).inject(post(payload));
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error });
    expect(publisher.messages).toHaveLength(0);
  });

  it('rejects an unknown site key', async () => {
    const res = await (await app()).inject(post(JSON.stringify({ ...envelope(), site_key: 'pk_live_unknown' })));
    expect(res.statusCode).toBe(401);
  });

  it('enforces the origin list of a site key', async () => {
    const a = await app({ siteKeys: { pk_local_demo: { tenant_id: 'demo', origins: ['https://shop.example'] } } });
    expect((await a.inject(post(JSON.stringify(envelope()), { origin: 'https://evil.example' }))).statusCode).toBe(403);
    expect((await a.inject(post(JSON.stringify(envelope()), { origin: 'https://shop.example' }))).statusCode).toBe(202);
  });

  it('refuses a gzip bomb', async () => {
    const bomb = gzipSync(Buffer.alloc(5_000_000, 0x20));
    const res = await (await app({ maxDecompressedBytes: 1_000_000 })).inject(post(bomb));
    expect(res.statusCode).toBe(413);
  });

  it('returns 503 so the SDK retries when publishing fails', async () => {
    publisher.fail = true;
    const res = await (await app()).inject(post(JSON.stringify(envelope())));
    expect(res.statusCode).toBe(503);
  });

  it('answers CORS preflight from any origin', async () => {
    const res = await (await app()).inject({
      method: 'OPTIONS',
      url: '/v1/ingest',
      headers: { origin: 'https://shop.example', 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://shop.example');
  });
});
