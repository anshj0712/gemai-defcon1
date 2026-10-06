import { describe, expect, it } from 'vitest';
import type { ClickEvent } from '@cp/schema';
import { NODE, SessionScript, applyCouponScenario } from '@cp/testkit';
import { emptyState, normalize } from '../src/index.js';

const T0 = 1_790_000_000_000;
const clicks = (events: { kind: string }[]) => events.filter((e): e is ClickEvent => e.kind === 'click');

describe('normalize', () => {
  it('resolves a click on a span inside a button to the button', () => {
    const s = new SessionScript(T0).meta(0).snapshot(5).click(100, NODE.applyCouponLabel);
    const [click] = clicks(normalize(s.events, { seq: 0, skewMs: 0, state: emptyState() }).events);
    expect(click).toMatchObject({ nodeId: NODE.applyCoupon, selector: 'button#apply-coupon', tag: 'button', interactive: true, disabled: false });
  });

  it('flags disabled, non-interactive, and select targets', () => {
    const s = new SessionScript(T0)
      .meta(0)
      .snapshot(5)
      .click(100, NODE.disabledButton)
      .click(200, NODE.promoBanner)
      .click(300, NODE.countrySelect)
      .click(400, NODE.couponInput)
      .click(500, NODE.helpLink);
    const [disabled, promo, select, input, link] = clicks(normalize(s.events, { seq: 0, skewMs: 0, state: emptyState() }).events);
    expect(disabled).toMatchObject({ selector: 'button#place-order', interactive: true, disabled: true });
    expect(promo).toMatchObject({ selector: null, interactive: false });
    expect(select).toMatchObject({ tag: 'select', interactive: true });
    expect(input).toMatchObject({ interactive: false });
    expect(link).toMatchObject({ selector: 'a.help', interactive: true });
  });

  it('carries the DOM index across chunks', () => {
    const first = normalize(new SessionScript(T0).meta(0).snapshot(5).events, { seq: 0, skewMs: 0, state: emptyState() });
    const second = normalize(new SessionScript(T0).click(6000, NODE.checkout).events, { seq: 1, skewMs: 0, state: first.state });
    expect(clicks(second.events)[0]).toMatchObject({ selector: 'button#checkout', seq: 1 });
  });

  it('does not modify the state it is given', () => {
    const state = emptyState();
    normalize(new SessionScript(T0).meta(0).snapshot(5).events, { seq: 0, skewMs: 0, state });
    expect(state).toEqual(emptyState());
  });

  it('indexes nodes added later and applies attribute changes', () => {
    const s = new SessionScript(T0)
      .meta(0)
      .snapshot(5)
      .addNodes(100, [{ parentId: NODE.checkout, nextId: null, node: { type: 2, id: 900, tagName: 'i', attributes: { class: 'icon' }, childNodes: [] } }])
      .addNodes(150, [
        // Child listed before its parent: still resolves to the new button.
        { parentId: 901, nextId: null, node: { type: 2, id: 902, tagName: 'span', attributes: {}, childNodes: [] } },
        { parentId: NODE.app, nextId: null, node: { type: 2, id: 901, tagName: 'button', attributes: { 'data-testid': 'retry' }, childNodes: [] } },
      ])
      .mutateAttributes(200, NODE.checkout, { disabled: '' })
      .click(300, 900)
      .click(400, 902);
    const [icon, retry] = clicks(normalize(s.events, { seq: 0, skewMs: 0, state: emptyState() }).events);
    expect(icon).toMatchObject({ nodeId: NODE.checkout, selector: 'button#checkout', disabled: true });
    expect(retry).toMatchObject({ nodeId: 901, selector: 'button[data-testid="retry"]' });
  });

  it('emits input changes without their text', () => {
    const s = new SessionScript(T0).meta(0).snapshot(5).input(100, NODE.couponInput, 'SAVE10');
    const out = normalize(s.events, { seq: 0, skewMs: 0, state: emptyState() });
    expect(out.events).toEqual([{ kind: 'input', t: T0 + 100, seq: 0, nodeId: NODE.couponInput }]);
    expect(JSON.stringify(out)).not.toContain('SAVE10');
  });

  it('maps network events so that t is always the request start', () => {
    const s = new SessionScript(T0)
      .net(100, { phase: 'start', route: '/api/coupon' })
      .net(400, { phase: 'end', route: '/api/coupon', status: 500, duration_ms: 300 });
    const [start, end] = normalize(s.events, { seq: 0, skewMs: 0, state: emptyState() }).events;
    expect(start).toMatchObject({ kind: 'request', phase: 'start', t: T0 + 100, tEnd: T0 + 100 });
    expect(end).toMatchObject({ kind: 'request', phase: 'end', t: T0 + 100, tEnd: T0 + 400, status: 500 });
  });

  it('applies clock skew to every event', () => {
    const s = new SessionScript(T0).meta(0).snapshot(5).click(100, NODE.checkout);
    const [click] = clicks(normalize(s.events, { seq: 0, skewMs: 60_000, state: emptyState() }).events);
    expect(click?.t).toBe(T0 + 100 + 60_000);
  });

  it('treats a Meta event as navigation only when the path changes', () => {
    const s = new SessionScript(T0).meta(0).snapshot(5).meta(1000).snapshot(1005).meta(2000, 'http://localhost:5173/checkout?x=1');
    const out = normalize(s.events, { seq: 0, skewMs: 0, state: emptyState() });
    expect(out.events).toEqual([{ kind: 'navigation', t: T0 + 2000, seq: 0, reason: 'load', route: '/checkout' }]);
    expect(out.state.path).toBe('/checkout');
  });

  it('stamps each click with the route it happened on, across SPA navigations and chunks', () => {
    const first = normalize(
      new SessionScript(T0).meta(0).snapshot(5).click(100, NODE.checkout).nav(200, 'spa', '/checkout').click(300, NODE.helpLink).events,
      { seq: 0, skewMs: 0, state: emptyState() },
    );
    const [onCart, onCheckout] = clicks(first.events);
    expect(onCart?.route).toBe('/cart');
    expect(onCheckout?.route).toBe('/checkout');
    const second = normalize(new SessionScript(T0).click(6000, NODE.checkout).events, { seq: 1, skewMs: 0, state: first.state });
    expect(clicks(second.events)[0]?.route).toBe('/checkout');
  });

  it('maps probe snapshots with the route they were taken on, and drops malformed ones', () => {
    const s = new SessionScript(T0)
      .meta(0)
      .snapshot(5)
      .probe(100, { cart_total: [1718100], line_total: [1079500, 829500], discount: [190900] })
      .custom(200, 'cp.probe', { values: { 'Bad Name': [1] } });
    const out = normalize(s.events, { seq: 3, skewMs: 0, state: emptyState() });
    expect(out.events).toEqual([
      { kind: 'probe', t: T0 + 100, seq: 3, values: { cart_total: [1718100], line_total: [1079500, 829500], discount: [190900] }, currency: 'INR', route: '/cart' },
    ]);
    expect(out.stats.probes).toBe(1);
  });

  it('ignores malformed and unknown events', () => {
    const out = normalize([null, { type: 3 }, { type: 5, timestamp: T0, data: { tag: 'cp.net', payload: { nope: 1 } } }, { type: 6, timestamp: T0 }], {
      seq: 0,
      skewMs: 0,
      state: emptyState(),
    });
    expect(out.events).toEqual([]);
    expect(out.stats.ignored).toBe(4);
  });

  it('normalizes the Apply Coupon scenario', () => {
    const { events } = applyCouponScenario({ start: T0, clicks: 7, respondFirst: 5 });
    const out = normalize(events, { seq: 0, skewMs: 0, state: emptyState() });
    expect(out.stats.clicks).toBe(7);
    expect(new Set(clicks(out.events).map((c) => c.selector))).toEqual(new Set(['button#apply-coupon']));
  });
});
