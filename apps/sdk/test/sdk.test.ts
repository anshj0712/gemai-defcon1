import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { errorSignature } from '../src/errors.js';
import { instrumentNetwork } from '../src/net.js';
import { maskPatterns, maskText, sanitizeEvent } from '../src/privacy.js';
import { parseCount, parseMoney, ProbeSnapshotter, readProbes } from '../src/probes.js';
import { routeTemplate, urlRoute } from '../src/route.js';
import { newSessionId, Session, type KeyValueStore } from '../src/session.js';
import { Batcher, gzipText, type TransportDeps } from '../src/transport.js';

const memoryStore = (): KeyValueStore => {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};

describe('Session', () => {
  it('keeps id and seq across page loads in the same tab', () => {
    const store = memoryStore();
    const first = new Session(store);
    expect([first.nextSeq(), first.nextSeq()]).toEqual([0, 1]);
    const afterReload = new Session(store);
    expect(afterReload.id).toBe(first.id);
    expect(afterReload.nextSeq()).toBe(2);
  });

  it('makes ids the collector accepts', () => {
    expect(newSessionId()).toMatch(/^s_[0-9a-z]{20}$/);
  });

  it('decides sampling once per session', () => {
    const store = memoryStore();
    expect(new Session(store).sampled(0.5, () => 0.9)).toBe(false);
    expect(new Session(store).sampled(0.5, () => 0.1)).toBe(false);
  });
});

describe('routes', () => {
  it.each([
    ['/product/42?ref=x', '/product/:id'],
    ['/order/3f9a2c1b-1a2b-4c3d-8e9f-0123456789ab', '/order/:id'],
    ['/cart', '/cart'],
    ['/', '/'],
  ])('%s -> %s', (path, route) => expect(routeTemplate(path)).toBe(route));

  it('templates request URLs without origin or query', () => {
    expect(urlRoute('/api/coupon?code=SAVE10', 'http://localhost:5173/cart')).toBe('/api/coupon');
    expect(urlRoute('https://api.example.com/v2/orders/991', 'http://localhost:5173/')).toBe('/v2/orders/:id');
  });
});

describe('privacy masks', () => {
  it.each([
    ['Signed in as asha.rao@example.com', 'asha.rao@example.com'],
    ['Card 4111 1111 1111 1111 charged', '4111 1111 1111 1111'],
    ['Call +91 98765 43210', '98765 43210'],
  ])('masks %s', (text, secret) => {
    const out = maskPatterns(text);
    expect(out).not.toContain(secret);
    expect(out).toHaveLength(text.length);
  });

  it.each(['₹1,299.00', 'Qty 3', '2026-09-25', 'Apply Coupon'])('keeps %s', (text) => expect(maskPatterns(text)).toBe(text));

  it('drops the query string and fragment from page-load URLs before they leave the browser', () => {
    const meta = { type: 4, timestamp: 1, data: { href: 'https://shop.example/cart?email=a@b.co&bugs=x#pay', width: 1, height: 1 } };
    expect(sanitizeEvent(meta).data).toEqual({ href: 'https://shop.example/cart', width: 1, height: 1 });
    const other = { type: 3, timestamp: 1, data: { href: 'x?y' } };
    expect(sanitizeEvent(other)).toBe(other);
  });

  it('fully masks text inside [data-cp-mask]', () => {
    const inside = { closest: (s: string) => (s === '[data-cp-mask]' ? {} : null) } as unknown as HTMLElement;
    expect(maskText('Asha Rao, 12 MG Road', inside)).toBe('*'.repeat(20));
    expect(maskText('Asha Rao', null)).toBe('Asha Rao');
  });
});

describe('errorSignature', () => {
  it('uses the error type and first frame, never the message', () => {
    const err = new TypeError('Cannot read region of asha@example.com');
    err.stack = 'TypeError: Cannot read region of asha@example.com\n    at pay (http://localhost:5173/src/checkout.ts?t=123:42:7)\n    at x (y.js:1:1)';
    expect(errorSignature(err)).toBe('TypeError at checkout.ts:42');
  });

  it('falls back to the event location', () => {
    expect(errorSignature('boom', { filename: 'https://shop/app.js?v=2', lineno: 9 })).toBe('string at app.js:9');
  });
});

describe('Batcher', () => {
  function harness(responses: (number | 'network')[]) {
    const sent: { body: unknown; keepalive: boolean | undefined }[] = [];
    let t = 1_790_000_000_000;
    const deps: TransportDeps = {
      url: 'http://collector/v1/ingest',
      fetch: (async (_url: string, init: RequestInit) => {
        const next = responses.shift() ?? 202;
        const raw = init.body as Uint8Array | string;
        sent.push({ body: JSON.parse(typeof raw === 'string' ? raw : gunzipSync(raw).toString()), keepalive: init.keepalive });
        if (next === 'network') throw new TypeError('Failed to fetch');
        return new Response(null, { status: next });
      }) as unknown as typeof fetch,
      gzip: gzipText,
      now: () => (t += 100),
      sleep: async () => undefined,
    };
    const store = memoryStore();
    const batcher = new Batcher(new Session(store), { siteKey: 'pk_local_demo', release: 'r', sdkVersion: '0', sampleRate: 1, page: () => ({ route: '/cart', url_path: '/cart' }) }, deps, 3);
    return { batcher, sent, store };
  }

  it('sends gzipped envelopes with contiguous seq', async () => {
    const { batcher, sent } = harness([]);
    batcher.add({ type: 4, timestamp: 1 });
    await batcher.flush();
    batcher.add({ type: 3, timestamp: 2 });
    batcher.addBusiness({ name: 'cart_viewed', value_minor: 129900, currency: 'INR' });
    await batcher.flush();
    expect(sent.map((s) => (s.body as { seq: number }).seq)).toEqual([0, 1]);
    expect(sent[1]?.body).toMatchObject({ site_key: 'pk_local_demo', page: { route: '/cart' }, business_events: [{ name: 'cart_viewed' }] });
  });

  it('retries a failed batch with the same seq and a fresh send time', async () => {
    const { batcher, sent } = harness([503, 'network', 202]);
    batcher.add({ type: 4, timestamp: 1 });
    await batcher.flush();
    const bodies = sent.map((s) => s.body as { seq: number; client_sent_at: number });
    expect(bodies.map((b) => b.seq)).toEqual([0, 0, 0]);
    expect(new Set(bodies.map((b) => b.client_sent_at)).size).toBe(3);
  });

  it('does not retry a batch the collector rejected as invalid', async () => {
    const { batcher, sent } = harness([400]);
    batcher.add({ type: 4, timestamp: 1 });
    await batcher.flush();
    expect(sent).toHaveLength(1);
  });

  it('flushes on its own when the batch is full, and skips empty flushes', async () => {
    const { batcher, sent } = harness([]);
    await batcher.flush();
    for (let i = 0; i < 3; i++) batcher.add({ type: 3, timestamp: i });
    await batcher.flush();
    expect(sent).toHaveLength(1);
    expect((sent[0]?.body as { events: unknown[] }).events).toHaveLength(3);
  });
});

describe('probes', () => {
  it.each([
    ['₹17,181', 1718100],
    ['₹1,079.5', 107950],
    ['₹2,49,900', 24990000],
    ['$12.99', 1299],
    ['Total: ₹0', 0],
    ['- ₹1,909', 190900],
    ['-1909', -190900],
    ['no number', null],
  ])('parseMoney(%s) = %s', (text, minor) => {
    expect(parseMoney(text)).toBe(minor);
  });

  it('parses a decimal comma when asked', () => {
    expect(parseMoney('1.234,56 €', { decimal: ',' })).toBe(123456);
  });

  it('parses counts', () => {
    expect(parseCount('Qty 3')).toBe(3);
    expect(parseCount('')).toBeNull();
  });

  const root = (dom: Record<string, (string | null)[]>) => ({
    querySelectorAll: (sel: string) => {
      if (!(sel in dom)) throw new SyntaxError('bad selector');
      return dom[sel]!.map((textContent) => ({ textContent }));
    },
  });

  it('reads every match in order, as numbers only, skipping bad names and selectors', () => {
    const values = readProbes(root({ '#total': ['₹17,181'], '.line': ['₹10,795', '₹8,295', 'n/a'], '.qty': ['1', '2'] }), [
      { name: 'cart_total', selector: '#total' },
      { name: 'line_total', selector: '.line' },
      { name: 'qty', selector: '.qty', kind: 'count' },
      { name: 'Bad Name', selector: '#total' },
      { name: 'broken', selector: '###' },
    ]);
    expect(values).toEqual({ cart_total: [1718100], line_total: [1079500, 829500], qty: [1, 2] });
  });

  it('emits a snapshot only when the numbers change, and not for pages without probes', () => {
    let current: Record<string, number[]> = { cart_total: [] };
    const emitted: unknown[] = [];
    const snap = new ProbeSnapshotter(() => current, (p) => emitted.push(p), 'INR');
    expect(snap.check()).toBe(false);
    current = { cart_total: [100] };
    expect(snap.check()).toBe(true);
    expect(snap.check()).toBe(false);
    current = { cart_total: [200] };
    snap.check();
    current = { cart_total: [] };
    snap.check();
    expect(emitted).toEqual([
      { values: { cart_total: [100] }, currency: 'INR' },
      { values: { cart_total: [200] }, currency: 'INR' },
      { values: { cart_total: [] }, currency: 'INR' },
    ]);
  });
});

describe('instrumentNetwork', () => {
  it('emits start and end with route template and status only, skipping the collector', async () => {
    const emitted: { tag: string; payload: Record<string, unknown> }[] = [];
    const target = {
      location: { href: 'http://localhost:5173/cart' },
      fetch: (async () => new Response('{"secret":"body"}', { status: 500 })) as unknown as typeof fetch,
    };
    const restore = instrumentNetwork(target, (tag, payload) => emitted.push({ tag, payload: payload as Record<string, unknown> }), (u) => u.startsWith('http://localhost:8080'));
    await target.fetch('/api/checkout?region=north&email=a@b.co', { method: 'post', body: 'card=4111' });
    await target.fetch('http://localhost:8080/v1/ingest', { method: 'POST' });
    restore();

    expect(emitted.map((e) => [e.tag, e.payload.phase, e.payload.route, e.payload.method])).toEqual([
      ['cp.net', 'start', '/api/checkout', 'POST'],
      ['cp.net', 'end', '/api/checkout', 'POST'],
    ]);
    expect(emitted[1]?.payload.status).toBe(500);
    expect(JSON.stringify(emitted)).not.toMatch(/region|email|4111|secret/);
  });
});
