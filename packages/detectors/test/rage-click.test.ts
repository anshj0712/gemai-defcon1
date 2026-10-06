import { describe, expect, it } from 'vitest';
import { rageClick } from '../src/index.js';
import { T, click, jsError, mutation, requestEnd, requestStart, run } from './helpers.js';

const placeOrder = { nodeId: 30, selector: 'button#place-order', route: '/checkout' };

describe('rage_click', () => {
  it('fires once on a burst of unanswered clicks', () => {
    const { signals } = run(rageClick, [click(T + 1000), click(T + 1400), click(T + 1800), click(T + 2200)]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      detector: 'rage_click',
      eventTime: T + 1000,
      evidence: { tStart: T + 1000, tEnd: T + 2200, selector: 'button#apply-coupon', route: '/cart', values: { clicks: 4, failed: 4, span_ms: 1200, node_id: 9 } },
    });
  });

  it('ignores fast clicks on a control that answers every time (a quantity stepper)', () => {
    const plus = { nodeId: 21, selector: 'button[aria-label="Increase quantity"]' };
    expect(run(rageClick, [click(T + 1000, plus), mutation(T + 1020), click(T + 1300, plus), mutation(T + 1320), click(T + 1600, plus), mutation(T + 1620)]).signals).toEqual([]);
  });

  it('fires when the clicks are answered but the action fails (Place Order returning 500)', () => {
    const events = [
      click(T + 1000, placeOrder),
      requestStart(T + 1005, '/api/checkout'),
      mutation(T + 1010),
      requestEnd(T + 1005, T + 1300, 500),
      click(T + 1500, placeOrder),
      requestStart(T + 1505, '/api/checkout'),
      mutation(T + 1510),
      click(T + 1900, placeOrder),
      requestStart(T + 1905, '/api/checkout'),
      mutation(T + 1910),
      requestEnd(T + 1905, T + 2200, 500),
    ];
    const [signal] = run(rageClick, events).signals;
    expect(signal).toMatchObject({ evidence: { selector: 'button#place-order', route: '/checkout', values: { clicks: 3 } } });
    expect((signal?.evidence.values as { failed: number }).failed).toBeGreaterThanOrEqual(1);
  });

  it('counts a JS error after a click as a failure', () => {
    const events = [click(T + 1000), mutation(T + 1010), jsError(T + 1100), click(T + 1300), mutation(T + 1310), click(T + 1600), mutation(T + 1610)];
    expect(run(rageClick, events).signals).toHaveLength(1);
  });

  it('can run in classic mode without the failure condition', () => {
    const plus = { nodeId: 21, selector: 'button.plus' };
    const events = [click(T + 1000, plus), mutation(T + 1020), click(T + 1300, plus), mutation(T + 1320), click(T + 1600, plus), mutation(T + 1620)];
    expect(run(rageClick, events, { params: { requireFailure: 0 } }).signals).toHaveLength(1);
  });

  it('needs the minimum number of clicks', () => {
    expect(run(rageClick, [click(T + 1000), click(T + 1300)]).signals).toEqual([]);
  });

  it('treats 1.5 s as inclusive: three clicks spanning exactly 1500 ms fire, 1501 ms do not', () => {
    expect(run(rageClick, [click(T + 1000), click(T + 1750), click(T + 2500)]).signals).toHaveLength(1);
    expect(run(rageClick, [click(T + 1000), click(T + 1751), click(T + 2501)]).signals).toEqual([]);
  });

  it('does not combine clicks on different elements or far apart on screen', () => {
    expect(run(rageClick, [click(T + 1000), click(T + 1200, { nodeId: 10 }), click(T + 1400)]).signals).toEqual([]);
    expect(run(rageClick, [click(T + 1000), click(T + 1200, { x: 200 }), click(T + 1400, { x: 300 })]).signals).toEqual([]);
  });

  it('splits two bursts separated by a pause into two signals', () => {
    const events = [click(T + 1000), click(T + 1300), click(T + 1600), click(T + 5000), click(T + 5300), click(T + 5600)];
    expect(run(rageClick, events).signals.map((s) => s.eventTime)).toEqual([T + 1000, T + 5000]);
  });

  describe('across chunk boundaries', () => {
    const burst = [click(T + 4000), click(T + 4300), click(T + 4600)];

    it('waits while the burst could still grow or its outcome is unknown', () => {
      expect(run(rageClick, burst, { tEnd: T + 5000 }).signals).toEqual([]);
    });

    it('decides it once in the next chunk, with clicks that arrived there', () => {
      const next = run(rageClick, [click(T + 5200)], { tail: burst, prevHorizon: T + 5000, tEnd: T + 10_000 }).signals;
      expect(next).toHaveLength(1);
      expect(next[0]?.evidence.values).toMatchObject({ clicks: 4 });
      expect(run(rageClick, [], { tail: [...burst, click(T + 5200)], prevHorizon: T + 10_000, tEnd: T + 15_000 }).signals).toEqual([]);
    });
  });
});
