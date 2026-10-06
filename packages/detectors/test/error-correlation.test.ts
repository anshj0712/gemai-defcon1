import { describe, expect, it } from 'vitest';
import type { Signal } from '@cp/schema';
import { DETECTORS, deadClick, errorCorrelation, runDetectors } from '../src/index.js';
import { SESSION, T, chunkOf, click, jsError, mutation, requestEnd, requestStart, run } from './helpers.js';

const trigger = (tStart: number, tEnd = tStart, extra: Partial<Signal['evidence']> = {}): Signal => ({
  detector: 'rage_click',
  fingerprint: 'rage-fp',
  eventTime: tStart,
  evidence: { sessionId: SESSION, seq: 2, tStart, tEnd, selector: 'button#place-order', route: '/checkout', ...extra },
});

describe('error_correlation', () => {
  it('attaches a failed request during a rage burst to that burst’s element', () => {
    const [signal, ...rest] = run(errorCorrelation, [requestEnd(T + 1005, T + 1300, 500)], { signals: [trigger(T + 1000, T + 1900)] }).signals;
    expect(rest).toEqual([]);
    expect(signal).toMatchObject({
      detector: 'error_correlation',
      eventTime: T + 1000,
      evidence: {
        seq: 2,
        tStart: T + 1300,
        selector: 'button#place-order',
        route: '/checkout',
        values: { correlated_detector: 'rage_click', error_signature: 'HTTP 500 POST /api/checkout', error_kind: 'http', status: 500, lead_ms: -300 },
      },
    });
    expect(signal?.fingerprint).not.toBe('rage-fp');
  });

  it('looks back 2 s before the signal, inclusive', () => {
    expect(run(errorCorrelation, [jsError(T + 3000)], { signals: [trigger(T + 5000)] }).signals).toHaveLength(1);
    expect(run(errorCorrelation, [jsError(T + 2999)], { signals: [trigger(T + 5000)] }).signals).toEqual([]);
  });

  it('ignores failures after the signal, successful requests, and lone failures', () => {
    expect(run(errorCorrelation, [jsError(T + 6000)], { signals: [trigger(T + 5000)] }).signals).toEqual([]);
    expect(run(errorCorrelation, [requestEnd(T + 4000, T + 4500, 200)], { signals: [trigger(T + 5000)] }).signals).toEqual([]);
    expect(run(errorCorrelation, [jsError(T + 4500)], { signals: [] }).signals).toEqual([]);
  });

  it('treats a network failure (status 0) as a failure', () => {
    const [signal] = run(errorCorrelation, [requestEnd(T + 4000, T + 4500, 0)], { signals: [trigger(T + 5000)] }).signals;
    expect(signal?.evidence.values).toMatchObject({ error_signature: 'network error POST /api/checkout', status: 0 });
  });

  it('picks the most recent failure before the signal', () => {
    const [signal] = run(errorCorrelation, [jsError(T + 3500, 'TypeError at a.ts:1'), jsError(T + 4500, 'TypeError at b.ts:2')], { signals: [trigger(T + 5000)] }).signals;
    expect(signal?.evidence.values).toMatchObject({ error_signature: 'TypeError at b.ts:2', error_kind: 'js' });
  });

  it('sees errors that arrived in earlier chunks through the tail', () => {
    expect(run(errorCorrelation, [], { tail: [jsError(T + 4500)], signals: [trigger(T + 5000)] }).signals).toHaveLength(1);
  });
});

describe('two-pass registry', () => {
  it('runs correlators after the primary detectors, over their signals', () => {
    const events = [click(T + 1000), requestStart(T + 1005), mutation(T + 1010), requestEnd(T + 1005, T + 1200, 500), click(T + 3000)];
    const ctx = { tenantId: 'demo', sessionId: SESSION, release: 'r', route: '/cart', tail: [], prevHorizon: null };
    const runs = runDetectors(DETECTORS, ctx, chunkOf(events));
    const byId = Object.fromEntries(runs.map((r) => [r.detector.id, r]));
    expect(byId.dead_click?.signals.map((s) => s.eventTime)).toEqual([T + 3000]);
    expect(byId.error_correlation?.signals).toHaveLength(1);
    expect(byId.error_correlation?.signals[0]?.evidence.values).toMatchObject({ correlated_detector: 'dead_click' });
    expect(runs.map((r) => r.detector.id).at(-1)).toBe('error_correlation');
  });

  it('returns detector state for the processor to carry', () => {
    const ctx = { tenantId: 'demo', sessionId: SESSION, release: 'r', route: '/cart', tail: [], prevHorizon: null };
    const runs = runDetectors([deadClick, ...DETECTORS.filter((d) => d.id === 'response_decay')], ctx, chunkOf([click(T + 1000), mutation(T + 1100)]));
    expect(runs.find((r) => r.detector.id === 'response_decay')?.state).toMatchObject({ elements: { '/cart|button#apply-coupon': { ok: 1 } } });
    expect(runs.find((r) => r.detector.id === 'dead_click')).not.toHaveProperty('state');
  });
});
