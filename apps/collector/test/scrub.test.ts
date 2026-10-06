import { describe, expect, it } from 'vitest';
import { piiEnvelope } from '@cp/testkit';
import { emptyStats, scrubEnvelope, scrubString, stripQuery } from '../src/scrub.js';

describe('scrubEnvelope (PII fixture)', () => {
  const input = piiEnvelope(1_790_000_000_000);
  const { envelope, stats } = scrubEnvelope(input);
  const out = JSON.stringify(envelope);

  it.each([
    ['email in text', 'asha.rao@example.com'],
    ['email in a mutation', 'ravi@example.org'],
    ['phone number', '98765 43210'],
    ['bare phone number in a textarea', '9876543210'],
    ['card number in a value attribute', '4111 1111 1111 1111'],
    ['card number typed into an input', '4111111111111111'],
    ['card number in page text', '4000-0566-5566-5556'],
    ['hidden input value', 'secret-hidden-token'],
    ['hidden input value set by a mutation', 'another-hidden-secret'],
    ['textarea text', 'deliver to flat 4B'],
    ['query-string token', 'token=abc123'],
    ['query string on page url', 'coupon=SAVE10'],
    ['query string on a Meta href', 'session=xyz'],
    ['query string on a network route', 'email=asha'],
  ])('removes %s', (_what, secret) => {
    expect(out).not.toContain(secret);
  });

  it('counts what it masked', () => {
    expect(stats.emails).toBeGreaterThanOrEqual(2);
    expect(stats.cards).toBeGreaterThanOrEqual(1);
    expect(stats.inputValues).toBeGreaterThanOrEqual(2);
    expect(stats.inputTexts).toBe(1);
    expect(stats.textareas).toBe(1);
    expect(stats.urls).toBeGreaterThanOrEqual(4);
  });

  it('keeps structure, types, and non-sensitive content', () => {
    expect(envelope.events).toHaveLength(input.events.length);
    expect(envelope.events.map((e) => [e.type, e.timestamp])).toEqual(input.events.map((e) => [e.type, e.timestamp]));
    expect(envelope.page.url_path).toBe('/checkout');
    expect(out).toContain('https://shop.example.com/orders');
    expect(out).toContain('Orders');
    expect(out).toContain('"/api/orders"');
  });

  it('does not modify its input', () => {
    expect(JSON.stringify(input)).toContain('asha.rao@example.com');
  });
});

describe('scrubEnvelope (SVG and geometry)', () => {
  it('keeps SVG drawing data intact while still scrubbing text-bearing attributes', () => {
    const base = piiEnvelope(1_790_000_000_000);
    const svg = {
      type: 2,
      id: 50,
      tagName: 'svg',
      isSVG: true,
      attributes: { viewBox: '0 0 480 300', 'aria-label': 'Shoe for asha.rao@example.com' },
      childNodes: [
        { type: 2, id: 51, tagName: 'path', isSVG: true, attributes: { d: 'M60 240 C52 240 47 248 51 254 C55 260 64 262 76 262 L420 262', fill: '#111' }, childNodes: [] },
        { type: 2, id: 52, tagName: 'rect', isSVG: true, attributes: { x: '60', y: '90', width: '13', height: '26', rx: '4' }, childNodes: [] },
      ],
    };
    const mutation = { type: 3, timestamp: base.client_ts_start + 400, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 51, attributes: { d: 'M10 20 30 40 50 60 70 80 90 100' } }] } };
    const { envelope } = scrubEnvelope({ ...base, events: [...base.events, { type: 3, timestamp: base.client_ts_start + 300, data: { source: 0, texts: [], removes: [], attributes: [], adds: [{ parentId: 3, nextId: null, node: svg }] } }, mutation] as typeof base.events });
    const out = JSON.stringify(envelope);
    expect(out).toContain('"viewBox":"0 0 480 300"');
    expect(out).toContain('M60 240 C52 240 47 248 51 254 C55 260 64 262 76 262 L420 262');
    expect(out).toContain('M10 20 30 40 50 60 70 80 90 100');
    expect(out).not.toContain('asha.rao@example.com');
  });
});

describe('scrubString', () => {
  it.each(['1299.00', '₹1,299.00', '2026-09-25', 'Qty 3', 'Order #12345', 'SKU 4521-88'])('leaves %s alone', (s) => {
    expect(scrubString(s, emptyStats())).toBe(s);
  });

  it('keeps the original length so replay layout holds', () => {
    const s = 'mail me: a@b.co';
    expect(scrubString(s, emptyStats())).toHaveLength(s.length);
  });
});

describe('stripQuery', () => {
  it.each([
    ['/a?b=1', '/a'],
    ['/a#x', '/a'],
    ['https://x.y/p?q#f', 'https://x.y/p'],
    ['/plain', '/plain'],
  ])('%s -> %s', (input, expected) => expect(stripQuery(input)).toBe(expected));
});
