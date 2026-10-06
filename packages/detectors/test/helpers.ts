import type { ClickEvent, Detector, DetectorOutput, InvariantRule, NormalizedChunk, NormalizedEvent, SessionContext, Signal } from '@cp/schema';

export const T = 1_790_000_000_000;
export const SESSION = 's_detector_test_1';

export const click = (t: number, extra: Partial<ClickEvent> = {}): NormalizedEvent => ({
  kind: 'click',
  t,
  seq: 0,
  nodeId: 9,
  selector: 'button#apply-coupon',
  tag: 'button',
  interactive: true,
  disabled: false,
  route: '/cart',
  x: 100,
  y: 200,
  ...extra,
});

export const mutation = (t: number): NormalizedEvent => ({ kind: 'mutation', t, seq: 0, count: 1 });

export const requestStart = (t: number, route = '/api/coupon'): NormalizedEvent => ({ kind: 'request', phase: 'start', t, tEnd: t, seq: 0, method: 'POST', route, status: 0 });

export const requestEnd = (start: number, end: number, status: number, route = '/api/checkout'): NormalizedEvent => ({
  kind: 'request',
  phase: 'end',
  t: start,
  tEnd: end,
  seq: 0,
  method: 'POST',
  route,
  status,
});

export const jsError = (t: number, signature = 'TypeError at main.ts:120'): NormalizedEvent => ({ kind: 'error', t, seq: 0, errorKind: 'unhandledrejection', signature });

export const probe = (t: number, values: Record<string, number[]>, route = '/cart'): NormalizedEvent => ({ kind: 'probe', t, seq: 0, values, currency: 'INR', route });

export interface RunOpts {
  tail?: NormalizedEvent[];
  prevHorizon?: number | null;
  tEnd?: number;
  params?: Record<string, number | string>;
  state?: unknown;
  signals?: Signal[];
  rules?: InvariantRule[];
  seq?: number;
}

export function chunkOf(events: NormalizedEvent[], opts: RunOpts = {}): NormalizedChunk {
  return { sessionId: SESSION, seq: opts.seq ?? 0, route: '/cart', tStart: T, tEnd: opts.tEnd ?? T + 20_000, events };
}

export function ctxFor(detector: Detector, opts: RunOpts = {}): SessionContext {
  return {
    tenantId: 'demo',
    sessionId: SESSION,
    release: 'git:test',
    route: '/cart',
    tail: opts.tail ?? [],
    prevHorizon: opts.prevHorizon ?? null,
    params: { ...detector.params, ...opts.params },
    ...(opts.state !== undefined ? { state: opts.state } : {}),
    ...(opts.signals ? { signals: opts.signals } : {}),
    ...(opts.rules ? { rules: opts.rules } : {}),
  };
}

/** Run a detector and normalize its output to { signals, state }. */
export function run(detector: Detector, events: NormalizedEvent[], opts: RunOpts = {}): DetectorOutput {
  const out = detector.run(ctxFor(detector, opts), chunkOf(events, opts));
  return Array.isArray(out) ? { signals: out } : out;
}
