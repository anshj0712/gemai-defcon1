import { describe, expect, it } from 'vitest';
import { emptyState, normalize } from '@cp/normalizer';
import type { DetectorOutput, NormalizedChunk, NormalizedEvent, NormalizerState, SessionContext, Signal } from '@cp/schema';
import { applyCouponScenario, toEnvelopes } from '@cp/testkit';
import { deadClick } from '../src/index.js';

const T = 1_790_000_000_000;

const click = (t: number, extra: Partial<Extract<NormalizedEvent, { kind: 'click' }>> = {}): NormalizedEvent => ({
  kind: 'click',
  t,
  seq: 0,
  nodeId: 9,
  selector: 'button#apply-coupon',
  tag: 'button',
  interactive: true,
  disabled: false,
  route: '/cart',
  ...extra,
});
const mutation = (t: number): NormalizedEvent => ({ kind: 'mutation', t, seq: 0, count: 1 });
const signalsOf = (out: Signal[] | DetectorOutput): Signal[] => (Array.isArray(out) ? out : out.signals);

function run(events: NormalizedEvent[], opts: { tEnd?: number; tail?: NormalizedEvent[]; prevHorizon?: number | null; windowMs?: number } = {}): Signal[] {
  const ctx: SessionContext = {
    tenantId: 'demo',
    sessionId: 's_dead_click_test',
    release: 'git:test',
    route: '/cart',
    tail: opts.tail ?? [],
    prevHorizon: opts.prevHorizon ?? null,
    params: { windowMs: opts.windowMs ?? 800 },
  };
  const chunk: NormalizedChunk = { sessionId: ctx.sessionId, seq: 0, route: '/cart', tStart: T, tEnd: opts.tEnd ?? T + 5000, events };
  return signalsOf(deadClick.run(ctx, chunk));
}

describe('dead_click', () => {
  it('fires on a click with no response', () => {
    const [signal, ...rest] = run([click(T + 1000)]);
    expect(rest).toEqual([]);
    expect(signal).toMatchObject({
      detector: 'dead_click',
      eventTime: T + 1000,
      evidence: { sessionId: 's_dead_click_test', seq: 0, tStart: T + 1000, tEnd: T + 1800, selector: 'button#apply-coupon', route: '/cart', values: { window_ms: 800, node_id: 9 } },
    });
    expect(signal?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not fire when the DOM changes inside the window', () => {
    expect(run([click(T + 1000), mutation(T + 1400)])).toEqual([]);
  });

  it.each([
    ['navigation', { kind: 'navigation', t: T + 1100, seq: 0, reason: 'spa', route: '/checkout' }],
    ['request start', { kind: 'request', phase: 'start', t: T + 1010, tEnd: T + 1010, seq: 0, method: 'POST', route: '/api/coupon', status: 0 }],
    ['change on the clicked control', { kind: 'input', t: T + 1050, seq: 0, nodeId: 9 }],
  ] as [string, NormalizedEvent][])('does not fire when a %s follows', (_name, response) => {
    expect(run([click(T + 1000), response])).toEqual([]);
  });

  describe('responses caused by something else', () => {
    const checkout = (t: number) => click(t, { nodeId: 21, selector: 'button#checkout' });
    const navigation = (t: number): NormalizedEvent => ({ kind: 'navigation', t, seq: 0, reason: 'spa', route: '/checkout' });

    it('does not credit a dead click with what the next click elsewhere caused', () => {
      // Dead Apply Coupon at 1000, then Checkout at 1500, which navigates.
      const signals = run([click(T + 1000), checkout(T + 1500), navigation(T + 1500)]);
      expect(signals.map((x) => x.evidence.selector)).toEqual(['button#apply-coupon']);
    });

    it('still credits a response that lands before the next click elsewhere', () => {
      expect(run([click(T + 1000), mutation(T + 1200), checkout(T + 1500), navigation(T + 1500)])).toEqual([]);
    });

    it('does not count a change on another field (the focus leaving it) as a response', () => {
      // Typing a code then pressing Apply: rrweb records the code field's change as the press begins.
      expect(run([{ kind: 'input', t: T + 1000, seq: 0, nodeId: 4 }, click(T + 1000)])).toHaveLength(1);
    });

    it('lets a slow response answer repeated clicks on the same element', () => {
      expect(run([click(T + 1000), click(T + 1200), mutation(T + 1700)])).toEqual([]);
    });
  });

  it('treats the window as inclusive: a response at exactly 800 ms counts', () => {
    expect(run([click(T + 1000), mutation(T + 1800)])).toEqual([]);
  });

  it('fires when the first response comes 1 ms after the window', () => {
    expect(run([click(T + 1000), mutation(T + 1801)])).toHaveLength(1);
  });

  it('ignores responses that happened before the click', () => {
    expect(run([mutation(T + 999), click(T + 1000)])).toHaveLength(1);
  });

  it('honours a tenant windowMs override', () => {
    expect(run([click(T + 1000), mutation(T + 1900)], { windowMs: 1000 })).toEqual([]);
    expect(run([click(T + 1000), mutation(T + 1900)], { windowMs: 800 })).toHaveLength(1);
  });

  it.each([
    ['disabled', { disabled: true }],
    ['non-interactive', { interactive: false, selector: null, tag: null }],
    ['native select', { tag: 'select', selector: 'select#country' }],
  ] as const)('skips %s targets', (_name, extra) => {
    expect(run([click(T + 1000, extra)])).toEqual([]);
  });

  it('emits one signal per click, never duplicates', () => {
    const signals = run([click(T + 1000), click(T + 2000), click(T + 3000)]);
    expect(signals.map((s) => s.eventTime)).toEqual([T + 1000, T + 2000, T + 3000]);
    expect(new Set(signals.map((s) => s.fingerprint)).size).toBe(1);
  });

  it('is deterministic', () => {
    const events = [click(T + 1000), click(T + 2500), mutation(T + 2600)];
    expect(run(events)).toEqual(run(events));
  });

  describe('across chunk boundaries', () => {
    const late = click(T + 4800); // deadline T + 5600, after chunk 1's horizon (T + 5000)

    it('defers a click whose window extends past the horizon', () => {
      expect(run([late], { tEnd: T + 5000 })).toEqual([]);
    });

    it('decides it in the next chunk, seeing the response that arrived there', () => {
      expect(run([mutation(T + 5200)], { tail: [late], prevHorizon: T + 5000, tEnd: T + 10_000 })).toEqual([]);
    });

    it('fires in the next chunk when no response arrived', () => {
      const [signal] = run([], { tail: [late], prevHorizon: T + 5000, tEnd: T + 10_000 });
      expect(signal).toMatchObject({ eventTime: T + 4800, evidence: { seq: 0 } });
    });

    it('keeps the route of the click, not of the batch that decided it', () => {
      // The shopper clicked on /cart, then navigated; the deciding batch was sent from /checkout.
      const chunk: NormalizedChunk = { sessionId: 's_dead_click_test', seq: 1, route: '/checkout', tStart: T + 5000, tEnd: T + 10_000, events: [] };
      const ctx: SessionContext = { tenantId: 'demo', sessionId: 's_dead_click_test', release: 'r', route: '/checkout', tail: [late], prevHorizon: T + 5000, params: { windowMs: 800 } };
      const [signal] = signalsOf(deadClick.run(ctx, chunk));
      expect(signal?.evidence.route).toBe('/cart');
      expect(signal?.fingerprint).toBe(run([click(T + 1000)])[0]?.fingerprint);
    });

    it('never re-decides a click already decided in an earlier chunk', () => {
      const early = click(T + 1000); // deadline T + 1800, before prevHorizon
      expect(run([], { tail: [early], prevHorizon: T + 5000, tEnd: T + 10_000 })).toEqual([]);
    });
  });

  it('finds exactly the unanswered Apply Coupon clicks across real batches', () => {
    const scenario = applyCouponScenario({ start: T, clicks: 8, respondFirst: 5, gapMs: 1300 });
    const envelopes = toEnvelopes(scenario.events, { sessionId: 's_apply_coupon', batchMs: 3000, end: scenario.end });
    let state: NormalizerState = emptyState();
    let tail: NormalizedEvent[] = [];
    let prevHorizon: number | null = null;
    const signals: Signal[] = [];
    for (const env of envelopes) {
      const norm = normalize(env.events, { seq: env.seq, skewMs: 0, state });
      const chunk: NormalizedChunk = { sessionId: env.session_id, seq: env.seq, route: env.page.route, tStart: env.client_ts_start, tEnd: env.client_ts_end, events: norm.events };
      signals.push(...signalsOf(deadClick.run({ tenantId: 'demo', sessionId: env.session_id, release: env.release, route: env.page.route, tail, prevHorizon, params: deadClick.params }, chunk)));
      state = norm.state;
      tail = [...tail, ...norm.events].filter((e) => e.t >= chunk.tEnd - 10_000);
      prevHorizon = chunk.tEnd;
    }
    expect(envelopes.length).toBeGreaterThan(2);
    expect(signals.map((s) => s.eventTime)).toEqual(scenario.deadClickIndexes.map((i) => scenario.clickTimes[i]));
    expect(new Set(signals.map((s) => s.fingerprint)).size).toBe(1);
    expect(signals.every((s) => s.evidence.selector === 'button#apply-coupon')).toBe(true);
  });
});
