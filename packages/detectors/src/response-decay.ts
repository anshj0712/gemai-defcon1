import type { DetectorOutput, Detector, Signal } from '@cp/schema';
import { fingerprint } from './fingerprint.js';
import { decidedNow, isJudgeableClick, responseCheck } from './response.js';

interface ElementState {
  /** Clicks this element answered. */
  ok: number;
  /** Consecutive unanswered clicks since the last answered one. */
  streak: number;
  streakStart: number | null;
  streakSeq: number | null;
  /** Already reported for the current streak. */
  fired: boolean;
}

export interface ResponseDecayState {
  elements: Record<string, ElementState>;
}

/** Elements remembered per session; the oldest are forgotten first. */
const MAX_ELEMENTS = 200;

/**
 * response_decay: an element answered at least `minResponsive` clicks, then `minUnresponsive` or more
 * consecutive clicks got no response within `windowMs`. It is the "button that stops working after a
 * while" pattern, which a single dead click cannot tell apart from a button that never worked.
 *
 * Elements are keyed by route + selector (node ids change when a page re-renders). History can be
 * minutes long, so it lives in detector state carried between chunks, not in the event tail. Clicks
 * are judged with the same decision horizon as dead_click, so each click counts exactly once.
 */
export const responseDecay: Detector = {
  id: 'response_decay',
  version: '1.1.0',
  params: { windowMs: 800, minResponsive: 2, minUnresponsive: 3 },

  run(ctx, chunk): DetectorOutput {
    const windowMs = Number(ctx.params.windowMs ?? 800);
    const minResponsive = Number(ctx.params.minResponsive ?? 2);
    const minUnresponsive = Number(ctx.params.minUnresponsive ?? 3);
    const prior = (ctx.state as ResponseDecayState | undefined)?.elements ?? {};
    const elements: Record<string, ElementState> = structuredClone(prior);

    const stream = ctx.tail.length > 0 ? [...ctx.tail, ...chunk.events] : chunk.events;
    const respondedTo = responseCheck(stream, windowMs);
    const decided = stream
      .filter(isJudgeableClick)
      .filter((c) => c.selector !== null && decidedNow(c.t + windowMs, ctx.prevHorizon, chunk.tEnd))
      .sort((a, b) => a.t - b.t);

    const signals: Signal[] = [];
    for (const c of decided) {
      const route = c.route ?? chunk.route;
      const key = `${route}|${c.selector}`;
      const el = elements[key] ?? { ok: 0, streak: 0, streakStart: null, streakSeq: null, fired: false };
      if (respondedTo(c)) {
        el.ok += 1;
        el.streak = 0;
        el.streakStart = null;
        el.streakSeq = null;
        el.fired = false;
      } else {
        el.streak += 1;
        if (el.streak === 1) {
          el.streakStart = c.t;
          el.streakSeq = c.seq;
        }
        if (el.ok >= minResponsive && el.streak >= minUnresponsive && !el.fired) {
          el.fired = true;
          signals.push({
            detector: 'response_decay',
            fingerprint: fingerprint({ detector: 'response_decay', route, selector: c.selector }),
            eventTime: el.streakStart ?? c.t,
            evidence: {
              sessionId: chunk.sessionId,
              seq: el.streakSeq ?? c.seq,
              tStart: el.streakStart ?? c.t,
              tEnd: c.t + windowMs,
              ...(c.selector ? { selector: c.selector } : {}),
              route,
              values: { answered_before: el.ok, unanswered: el.streak, window_ms: windowMs, node_id: c.nodeId },
            },
          });
        }
      }
      delete elements[key];
      elements[key] = el;
    }

    const keys = Object.keys(elements);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ELEMENTS))) delete elements[k];
    return { signals, state: { elements } satisfies ResponseDecayState };
  },
};
