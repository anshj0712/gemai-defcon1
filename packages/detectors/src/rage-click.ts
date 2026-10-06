import type { ClickEvent, Detector, Signal } from '@cp/schema';
import { fingerprint } from './fingerprint.js';
import { decidedNow, failedWithin, isFailure, responseCheck } from './response.js';

/**
 * rage_click: a burst of `minClicks`+ clicks on one element within `windowMs` and `radiusPx`, where at
 * least `requireFailure` of those clicks failed: no response within `responseWindowMs`, or an error /
 * failed request within `errorWindowMs`.
 *
 * The failure condition is ours, not the textbook definition: plain fast clicking on a control that
 * works every time (a quantity stepper, a carousel arrow) is not frustration. Set requireFailure=0
 * for the classic behaviour.
 *
 * Bursts: consecutive clicks on the same node, each within `windowMs` of the previous and within
 * `radiusPx` of the burst's first click. A burst is decided once, in the chunk whose horizon first
 * passes its last click + max(windowMs, responseWindowMs, errorWindowMs), when it can no longer grow
 * and every click's outcome is known.
 */
export const rageClick: Detector = {
  id: 'rage_click',
  version: '1.1.0',
  params: { minClicks: 3, windowMs: 1500, radiusPx: 40, requireFailure: 1, responseWindowMs: 800, errorWindowMs: 2000 },

  run(ctx, chunk): Signal[] {
    const p = ctx.params;
    const minClicks = Number(p.minClicks ?? 3);
    const windowMs = Number(p.windowMs ?? 1500);
    const radius = Number(p.radiusPx ?? 40);
    const requireFailure = Number(p.requireFailure ?? 1);
    const responseWindowMs = Number(p.responseWindowMs ?? 800);
    const errorWindowMs = Number(p.errorWindowMs ?? 2000);
    const settleMs = Math.max(windowMs, responseWindowMs, errorWindowMs);

    const stream = ctx.tail.length > 0 ? [...ctx.tail, ...chunk.events] : chunk.events;
    const respondedTo = responseCheck(stream, responseWindowMs);
    const failures = stream.filter(isFailure);

    const byNode = new Map<number, ClickEvent[]>();
    for (const e of stream) {
      if (e.kind !== 'click') continue;
      const list = byNode.get(e.nodeId) ?? [];
      list.push(e);
      byNode.set(e.nodeId, list);
    }

    const signals: Signal[] = [];
    for (const clicks of byNode.values()) {
      for (const burst of bursts(clicks, windowMs, radius)) {
        if (burst.length < minClicks) continue;
        const last = burst[burst.length - 1]!;
        if (!decidedNow(last.t + settleMs, ctx.prevHorizon, chunk.tEnd)) continue;
        if (!hasDenseWindow(burst, minClicks, windowMs)) continue;

        const failed = burst.filter((c) => !respondedTo(c) || failedWithin(failures, c.t, errorWindowMs)).length;
        if (failed < requireFailure) continue;

        const first = burst[0]!;
        const route = first.route ?? chunk.route;
        signals.push({
          detector: 'rage_click',
          fingerprint: fingerprint({ detector: 'rage_click', route, selector: first.selector }),
          eventTime: first.t,
          evidence: {
            sessionId: chunk.sessionId,
            seq: first.seq,
            tStart: first.t,
            tEnd: last.t,
            ...(first.selector ? { selector: first.selector } : {}),
            route,
            values: { clicks: burst.length, failed, span_ms: last.t - first.t, node_id: first.nodeId },
          },
        });
      }
    }
    return signals.sort((a, b) => a.eventTime - b.eventTime);
  },
};

/** Split one node's clicks (time order) into bursts: gaps ≤ windowMs, all within radius of the first. */
export function bursts(clicks: readonly ClickEvent[], windowMs: number, radius: number): ClickEvent[][] {
  const out: ClickEvent[][] = [];
  let current: ClickEvent[] = [];
  for (const c of [...clicks].sort((a, b) => a.t - b.t)) {
    const first = current[0];
    const prev = current[current.length - 1];
    const near = !first || first.x === undefined || c.x === undefined || Math.hypot((c.x ?? 0) - (first.x ?? 0), (c.y ?? 0) - (first.y ?? 0)) <= radius;
    if (prev && c.t - prev.t <= windowMs && near) current.push(c);
    else {
      if (current.length > 0) out.push(current);
      current = [c];
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** True when some `n` consecutive clicks of the burst fit inside `windowMs`. */
function hasDenseWindow(burst: readonly ClickEvent[], n: number, windowMs: number): boolean {
  for (let i = 0; i + n - 1 < burst.length; i++) {
    if (burst[i + n - 1]!.t - burst[i]!.t <= windowMs) return true;
  }
  return false;
}
