import type { Detector, NormalizedEvent, Signal } from '@cp/schema';
import { fingerprint } from './fingerprint.js';
import { failureSignature, failureTime, isFailure } from './response.js';

/**
 * error_correlation: a JS error, unhandled rejection, or failed request (4xx/5xx/network) became
 * visible within `windowMs` before another signal, or during it (a rage burst spans several
 * seconds, and the error usually lands between the clicks).
 *
 * It runs in the second pass, over the signals the primary detectors produced for this chunk, and
 * inherits the triggering signal's route and element, so the error lands in the same cluster as the
 * symptom it explains. One correlation per triggering signal: the latest failure before it.
 */
export const errorCorrelation: Detector = {
  id: 'error_correlation',
  version: '1.0.0',
  phase: 'correlate',
  params: { windowMs: 2000 },

  run(ctx, chunk): Signal[] {
    const windowMs = Number(ctx.params.windowMs ?? 2000);
    const stream = ctx.tail.length > 0 ? [...ctx.tail, ...chunk.events] : chunk.events;
    const failures = stream.filter(isFailure);
    if (failures.length === 0) return [];

    const out: Signal[] = [];
    for (const s of ctx.signals ?? []) {
      const from = s.evidence.tStart - windowMs;
      const to = Math.max(s.evidence.tEnd, s.evidence.tStart);
      let best: NormalizedEvent | undefined;
      for (const f of failures) {
        const at = failureTime(f);
        if (at >= from && at <= to && (!best || at > failureTime(best))) best = f;
      }
      if (!best) continue;

      const signature = failureSignature(best);
      const route = s.evidence.route ?? chunk.route;
      out.push({
        detector: 'error_correlation',
        fingerprint: fingerprint({ detector: 'error_correlation', route, selector: s.evidence.selector ?? null, errorSignature: signature }),
        eventTime: s.eventTime,
        evidence: {
          sessionId: s.evidence.sessionId,
          seq: s.evidence.seq,
          tStart: failureTime(best),
          tEnd: s.evidence.tEnd,
          ...(s.evidence.selector ? { selector: s.evidence.selector } : {}),
          route,
          values: {
            correlated_detector: s.detector,
            correlated_fingerprint: s.fingerprint,
            error_signature: signature,
            error_kind: best.kind === 'error' ? 'js' : 'http',
            ...(best.kind === 'request' ? { status: best.status } : {}),
            lead_ms: s.evidence.tStart - failureTime(best),
            ...(typeof s.evidence.values?.rule_id === 'string' ? { rule_id: s.evidence.values.rule_id } : {}),
          },
        },
      });
    }
    return out;
  },
};
