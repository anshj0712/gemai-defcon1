import { NodeType } from '@rrweb/types';
import { describe, expect, it } from 'vitest';
import { requestProbeBase, requestProbeNames, type ProbeEvent, type RecordedProbeSpec } from '@cp/schema';
import { NODE, SessionScript, cartDocument } from '@cp/testkit';
import { compileSelector, emptyState, MAX_MIRROR_NODES, normalize, numericCandidates, queryMirror, readRecordedProbes, SETTLE_MS, textOf } from '../src/index.js';
import { applyMirrorMutation, mirrorSnapshot } from '../src/mirror.js';

const T0 = 1_790_000_000_000;
const probes = (events: { kind: string }[]) => events.filter((e): e is ProbeEvent => e.kind === 'probe');
const el = (id: number, tagName: string, attributes: Record<string, string> = {}, childNodes: unknown[] = []) => ({ type: NodeType.Element, id, tagName, attributes, childNodes });
const text = (id: number, textContent: string) => ({ type: NodeType.Text, id, textContent });

describe('selectors (the CSS subset)', () => {
  it('compiles tags, ids, classes, attributes, and descendant and child combinators', () => {
    for (const s of ['#delivery-fee', 'span#delivery-fee', '.cart-total', 'div.cart-total', '[data-cp-probe="cart_total"]', "[data-testid='x']", '[data-id]', '#app .cart-total', '#app > div.cart-total', 'aside span.fee', '[class^="cart"]', '*']) {
      expect(compileSelector(s), s).not.toBeNull();
    }
  });

  it('refuses pseudo-classes, lists, sibling combinators, and junk', () => {
    for (const s of ['li:nth-child(2)', 'a, b', 'a + b', 'a ~ b', '', '#', '.', '[x', 'div::after', '>div']) expect(compileSelector(s), s).toBeNull();
  });

  it('finds elements in the mirrored page, in document order', () => {
    const m = mirrorSnapshot(cartDocument());
    const ids = (s: string) => queryMirror(m, compileSelector(s)!);
    expect(ids('.cart-total')).toEqual([NODE.total]);
    expect(ids('#app > div.cart-total')).toEqual([NODE.total]);
    expect(ids('form button.btn')).toEqual([NODE.applyCoupon]);
    expect(ids('body > button')).toEqual([]);
    expect(ids('button')).toEqual([NODE.applyCoupon, NODE.checkout, NODE.disabledButton]);
    expect(textOf(m, NODE.total)).toBe('1299.00');
  });
});

describe('the recorded-page mirror', () => {
  it('applies adds (in sibling order), removes, text and attribute changes', () => {
    const m = mirrorSnapshot(cartDocument());
    applyMirrorMutation(m, {
      // The second line is listed first but goes after the first (its nextId is null; the first's next is it).
      adds: [
        { parentId: 500, nextId: null, node: text(503, 'Shipping') },
        { parentId: NODE.app, nextId: 501, node: el(500, 'p', { class: 'line' }) },
        { parentId: NODE.app, nextId: null, node: el(501, 'p', { class: 'line' }, [text(502, '₹499')]) },
      ],
      texts: [{ id: NODE.totalText, value: '1,798.00' }],
      attributes: [{ id: NODE.total, attributes: { id: 'cart-total', 'data-cp-probe': 'cart_total', style: 'color:red' } }],
    });
    expect(queryMirror(m, compileSelector('p.line')!)).toEqual([500, 501]);
    expect(textOf(m, 500)).toBe('Shipping');
    expect(textOf(m, NODE.total)).toBe('1,798.00');
    expect(m.n[NODE.total]!.a).toEqual({ class: 'cart-total', id: 'cart-total', 'data-cp-probe': 'cart_total' });
    applyMirrorMutation(m, { removes: [{ id: 501 }] });
    expect(m.n[501]).toBeUndefined();
    expect(m.n[502]).toBeUndefined();
    expect(m.n[NODE.app]!.c).not.toContain(501);
  });

  it('keeps svg and script as opaque nodes, and stops growing past the cap', () => {
    const m = mirrorSnapshot({ type: NodeType.Document, id: 1, childNodes: [el(2, 'svg', {}, [el(3, 'path'), el(4, 'path')]), el(5, 'div', {}, [text(6, 'ok')])] });
    expect(m.n[2]).toMatchObject({ t: 'svg', s: 1 });
    expect(m.n[3]).toBeUndefined();
    applyMirrorMutation(m, { adds: [{ parentId: 2, nextId: null, node: el(7, 'circle') }] });
    expect(m.n[7]).toBeUndefined();
    const big = mirrorSnapshot({ type: NodeType.Document, id: 1, childNodes: Array.from({ length: MAX_MIRROR_NODES + 10 }, (_, i) => el(10 + i, 'span')) });
    expect(big.size).toBe(MAX_MIRROR_NODES);
    expect(big.truncated).toBe(true);
  });

  it('reads recorded probes by kind and page, leaving out probes that match nothing', () => {
    const m = mirrorSnapshot(cartDocument());
    const specs: RecordedProbeSpec[] = [
      { name: 'shown_total', selector: '.cart-total', kind: 'money' },
      { name: 'promo_pct', selector: '.promo-banner', kind: 'count' },
      { name: 'other_page', selector: '.cart-total', kind: 'money', routes: ['/checkout'] },
      { name: 'missing', selector: '#nope', kind: 'money' },
    ];
    expect(readRecordedProbes(m, specs, '/cart')).toEqual({ shown_total: [129900], promo_pct: [10] });
  });

  it('discovers short numbers on the page, deepest element first, outside controls', () => {
    const m = mirrorSnapshot({
      type: NodeType.Document,
      id: 1,
      childNodes: [
        el(2, 'main', { id: 'checkout' }, [
          el(3, 'span', { id: 'delivery-fee' }, [text(4, '₹499')]),
          el(5, 'p', { class: 'eta' }, [text(6, 'Arrives in 9–12 business days')]),
          el(7, 'button', { id: 'pay' }, [el(8, 'span', { class: 'amount' }, [text(9, '₹1,299')])]),
          el(10, 'div', { class: 'row' }, [el(11, 'span', {}, [text(12, '42')])]),
          el(13, 'p', {}, [text(14, 'A long paragraph that mentions 3 things and runs well past forty characters')]),
        ]),
      ],
    });
    expect(numericCandidates(m)).toEqual([
      { selector: 'span#delivery-fee', kind: 'money', values: [49900] },
      { selector: 'p.eta', kind: 'count', values: [9] },
    ]);
  });
});

describe('normalize: request probes', () => {
  it('turns each finished request into a duration and a status probe, on the page it happened', () => {
    const s = new SessionScript(T0)
      .meta(0, 'http://localhost:5173/checkout')
      .snapshot(5)
      .net(100, { phase: 'start', method: 'POST', route: '/api/payment/authorize' })
      .net(6700, { phase: 'end', method: 'POST', route: '/api/payment/authorize', status: 200, duration_ms: 6600 });
    const out = normalize(s.events, { seq: 0, skewMs: 0, state: emptyState() });
    const names = requestProbeNames('POST', '/api/payment/authorize');
    expect(names).toEqual({ ms: 'req_post_api_payment_authorize_ms', status: 'req_post_api_payment_authorize_status' });
    expect(probes(out.events)).toEqual([{ kind: 'probe', t: T0 + 6700, seq: 0, values: { [names.ms]: [6600], [names.status]: [200] }, currency: null, route: '/checkout', source: 'request' }]);
    expect(out.stats).toMatchObject({ requests: 2, probes: 0, derived_probes: 1 });
    expect(probes(normalize(s.events, { seq: 0, skewMs: 0, state: emptyState(), requestProbes: false }).events)).toEqual([]);
  });

  it('names request probes from the method and route template, cut to length with a stable suffix', () => {
    expect(requestProbeBase('GET', '/api/stock')).toBe('req_get_api_stock');
    expect(requestProbeBase('get', '/api/orders/:id/items')).toBe('req_get_api_orders_id_items');
    const long = requestProbeBase('POST', `/api/${'very-long-segment/'.repeat(6)}end`);
    expect(long.length).toBeLessThanOrEqual(56);
    expect(long).toBe(requestProbeBase('POST', `/api/${'very-long-segment/'.repeat(6)}end`));
    expect(long).not.toBe(requestProbeBase('POST', `/api/${'very-long-segment/'.repeat(6)}other`));
  });
});

describe('normalize: recorded probes', () => {
  const spec: RecordedProbeSpec[] = [{ name: 'shown_total', selector: '.cart-total', kind: 'money' }];

  it('reads a recorded probe once the page settles, and again only when its value changes', () => {
    const s = new SessionScript(T0)
      .meta(0)
      .snapshot(5)
      .probe(20, { cart_total: [129900] })
      .click(1000, NODE.checkout)
      .mutateText(2000, NODE.totalText, '1,798.00')
      .mutateText(2100, NODE.totalText, '1,798.00')
      .click(3000, NODE.checkout);
    const out = normalize(s.events, { seq: 0, skewMs: 0, state: emptyState(), recordedProbes: spec });
    const recorded = probes(out.events).filter((p) => p.source === 'recorded');
    expect(recorded).toEqual([
      { kind: 'probe', t: T0 + 5 + SETTLE_MS, seq: 0, values: { shown_total: [129900] }, currency: 'INR', route: '/cart', source: 'recorded' },
      { kind: 'probe', t: T0 + 2100 + SETTLE_MS, seq: 0, values: { shown_total: [179800] }, currency: 'INR', route: '/cart', source: 'recorded' },
    ]);
  });

  it('carries the mirror across chunks, so a later chunk reads the page an earlier one built', () => {
    const first = normalize(new SessionScript(T0).meta(0).snapshot(5).events, { seq: 0, skewMs: 0, state: emptyState(), mirror: true });
    expect(first.state.mirror?.size).toBeGreaterThan(10);
    // A probe registered after the page loaded is read at the next change, from the carried copy.
    const second = normalize(new SessionScript(T0).mutateText(6000, NODE.totalText, '999.00').events, { seq: 1, skewMs: 0, state: first.state, recordedProbes: spec });
    expect(probes(second.events)).toMatchObject([{ values: { shown_total: [99900] }, seq: 1, source: 'recorded' }]);
    // Without the mirror switch or any recorded probe, nothing is kept.
    expect(normalize(new SessionScript(T0).meta(0).snapshot(5).events, { seq: 0, skewMs: 0, state: emptyState() }).state.mirror).toBeUndefined();
  });

  it('collects the numbers on each settled page in discover mode', () => {
    const out = normalize(new SessionScript(T0).meta(0).snapshot(5).events, { seq: 0, skewMs: 0, state: emptyState(), discover: true });
    expect(out.discovered).toEqual([{ t: T0 + 5, route: '/cart', candidates: [{ selector: 'div.cart-total', kind: 'count', values: [1299] }, { selector: 'div.promo-banner', kind: 'count', values: [10] }] }]);
  });
});
