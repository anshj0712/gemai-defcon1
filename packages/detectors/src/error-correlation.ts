import type { ClickEvent, Detector, NormalizedEvent, Signal } from '@cp/schema';
import { fingerprint } from './fingerprint.js';
import { failureSignature, failureTime, isFailure, isJudgeableClick } from './response.js';

/**
 * error_correlation: a JS error, unhandled rejection, or failed request (4xx/5xx/network) became
 * visible within `windowMs` before another signal, or during it (a rage burst spans several
 * seconds, and the error usually lands between the clicks).
 *
 * It runs in the second pass, over the signals the primary detectors produced for this chunk, and
 * inherits the triggering signal's route and element, so the error lands in the same cluster as the
 * symptom it explains. One correlation per triggering signal: the latest failure before it.
 *
 * Standalone (`standalone` 1, the default; 0 restores correlation only): a failure no other signal
 * explains still matters when a shopper had just clicked something. One failed payment is a lost
 * order even though it is too few clicks for rage_click, so the first failure within `windowMs` after
 * a click becomes a signal on that click's element. It is emitted in the chunk the failure arrives in
 * (once, since a chunk is processed once), and failures with no click just before them are ignored.
 */
export const errorCorrelation: Detector = {
  id: 'error_correlation',
  version: '1.1.0',
  phase: 'correlate',
  params: { windowMs: 2000, standalone: 1 },

  run(ctx, chunk): Signal[] {
    const windowMs = Number(ctx.params.windowMs ?? 2000);
    const stream = ctx.tail.length > 0 ? [...ctx.tail, ...chunk.events] : chunk.events;
    const failures = stream.filter(isFailure);
    if (failures.length === 0) return [];

    const out: Signal[] = [];
    const explained = new Set<NormalizedEvent>();
    for (const s of ctx.signals ?? []) {
      const from = s.evidence.tStart - windowMs;
      const to = Math.max(s.evidence.tEnd, s.evidence.tStart);
      let best: NormalizedEvent | undefined;
      for (const f of failures) {
        const at = failureTime(f);
        if (at >= from && at <= to) {
          explained.add(f);
          if (!best || at > failureTime(best)) best = f;
        }
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

    if (Number(ctx.params.standalone ?? 1) !== 0) out.push(...standaloneFailures(stream, new Set(chunk.events), failures, explained, windowMs, chunk.route, chunk.sessionId));
    return out;
  },
};

/** The first unexplained failure after each judgeable click, when that failure arrived in this chunk. */
function standaloneFailures(
  stream: readonly NormalizedEvent[],
  fresh: ReadonlySet<NormalizedEvent>,
  failures: readonly NormalizedEvent[],
  explained: ReadonlySet<NormalizedEvent>,
  windowMs: number,
  chunkRoute: string,
  sessionId: string,
): Signal[] {
  const out: Signal[] = [];
  const open = failures.filter((f) => !explained.has(f));
  for (const c of stream) {
    if (c.kind !== 'click' || !isJudgeableClick(c)) continue;
    const click: ClickEvent = c;
    // The failure this click led to: the earliest one in its window (each failure belongs to the latest click before it).
    const first = open
      .filter((f) => failureTime(f) >= click.t && failureTime(f) - click.t <= windowMs)
      .filter((f) => !stream.some((o) => o.kind === 'click' && isJudgeableClick(o) && o.t > click.t && o.t <= failureTime(f)))
      .sort((a, b) => failureTime(a) - failureTime(b))[0];
    if (!first || !fresh.has(first)) continue;

    const signature = failureSignature(first);
    const route = click.route ?? chunkRoute;
    out.push({
      detector: 'error_correlation',
      fingerprint: fingerprint({ detector: 'error_correlation', route, selector: click.selector, errorSignature: signature }),
      eventTime: click.t,
      evidence: {
        sessionId,
        seq: click.seq,
        tStart: click.t,
        tEnd: failureTime(first),
        ...(click.selector ? { selector: click.selector } : {}),
        route,
        values: {
          standalone: true,
          error_signature: signature,
          error_kind: first.kind === 'error' ? 'js' : 'http',
          ...(first.kind === 'request' ? { status: first.status } : {}),
          lead_ms: failureTime(first) - click.t,
        },
      },
    });
  }
  return out;
}
