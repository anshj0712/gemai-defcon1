import type { Detector, Signal } from '@cp/schema';
import { fingerprint } from './fingerprint.js';
import { decidedNow, isJudgeableClick, responseCheck } from './response.js';

/**
 * dead_click: a click on an enabled interactive element followed by no DOM mutation, navigation,
 * request, or change on the clicked control within `windowMs` (inclusive), before the user's next
 * click elsewhere (see `responseCheck`).
 *
 * Chunk boundaries: a click is decided only in the chunk whose horizon first covers
 * `click.t + windowMs`. Clicks due at or before the previous horizon were decided earlier; clicks
 * due after this chunk's horizon wait in the session tail for the next chunk. So every click is
 * decided exactly once, with all the evidence its window can have.
 */
export const deadClick: Detector = {
  id: 'dead_click',
  version: '1.3.0',
  params: { windowMs: 800 },

  run(ctx, chunk): Signal[] {
    const windowMs = Number(ctx.params.windowMs ?? 800);
    const stream = ctx.tail.length > 0 ? [...ctx.tail, ...chunk.events] : chunk.events;
    const respondedTo = responseCheck(stream, windowMs);
    const signals: Signal[] = [];

    for (const e of stream) {
      if (!isJudgeableClick(e)) continue;
      const deadline = e.t + windowMs;
      if (!decidedNow(deadline, ctx.prevHorizon, chunk.tEnd)) continue;
      if (respondedTo(e)) continue;

      // The click's own route: the batch that decides it may have been sent after a navigation.
      const route = e.route ?? chunk.route;
      signals.push({
        detector: 'dead_click',
        fingerprint: fingerprint({ detector: 'dead_click', route, selector: e.selector }),
        eventTime: e.t,
        evidence: {
          sessionId: chunk.sessionId,
          seq: e.seq,
          tStart: e.t,
          tEnd: deadline,
          ...(e.selector ? { selector: e.selector } : {}),
          route,
          // node_id lets the replay viewer find the exact element in the rebuilt DOM.
          values: { window_ms: windowMs, node_id: e.nodeId },
        },
      });
    }
    return signals;
  },
};
