import { describe, expect, it } from 'vitest';
import { responseDecay } from '../src/index.js';
import type { ResponseDecayState } from '../src/response-decay.js';
import { T, click, mutation, run } from './helpers.js';

/** Clicks one second apart; `answered` marks which ones got a response. */
function session(answered: boolean[], start = T + 1000) {
  return answered.flatMap((ok, i) => {
    const t = start + i * 1000;
    return ok ? [click(t), mutation(t + 100)] : [click(t)];
  });
}

describe('response_decay', () => {
  it('fires when a button that worked stops answering', () => {
    const { signals } = run(responseDecay, session([true, true, false, false, false]));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      detector: 'response_decay',
      eventTime: T + 3000,
      evidence: { tStart: T + 3000, tEnd: T + 5800, selector: 'button#apply-coupon', route: '/cart', values: { answered_before: 2, unanswered: 3 } },
    });
  });

  it('does not fire for a button that never worked (that is dead_click)', () => {
    expect(run(responseDecay, session([false, false, false, false])).signals).toEqual([]);
  });

  it('needs the minimum number of unanswered clicks in a row', () => {
    expect(run(responseDecay, session([true, true, false, false])).signals).toEqual([]);
    expect(run(responseDecay, session([true, true, false, false, true, false, false])).signals).toEqual([]);
  });

  it('reports a streak once, and again only after the element recovers and decays anew', () => {
    const { signals } = run(responseDecay, session([true, true, false, false, false, false, false, true, false, false, false]));
    expect(signals.map((s) => s.eventTime)).toEqual([T + 3000, T + 9000]);
  });

  it('remembers history across chunks through its state', () => {
    const first = run(responseDecay, session([true, true, false]), { tEnd: T + 5000 });
    expect(first.signals).toEqual([]);
    const second = run(responseDecay, session([false, false], T + 5000), { prevHorizon: T + 5000, tEnd: T + 10_000, state: first.state });
    expect(second.signals.map((s) => s.eventTime)).toEqual([T + 3000]);
    expect(second.signals[0]?.evidence.seq).toBe(0);
  });

  it('tracks elements separately by route and selector', () => {
    const other = { selector: 'button#checkout', nodeId: 14 };
    const events = [click(T + 1000), mutation(T + 1100), click(T + 2000), mutation(T + 2100), click(T + 3000, other), click(T + 4000, other), click(T + 5000, other)];
    expect(run(responseDecay, events).signals).toEqual([]);
  });

  it('does not modify the state it is given', () => {
    const state: ResponseDecayState = { elements: { '/cart|button#apply-coupon': { ok: 2, streak: 0, streakStart: null, streakSeq: null, fired: false } } };
    const copy = structuredClone(state);
    run(responseDecay, session([false, false, false]), { state });
    expect(state).toEqual(copy);
  });
});
