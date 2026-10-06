import type { ClickEvent, NormalizedEvent } from '@cp/schema';

/** Anything that shows the page reacted to a click. */
export function isResponse(e: NormalizedEvent): boolean {
  return e.kind === 'mutation' || e.kind === 'navigation' || e.kind === 'request' || e.kind === 'input';
}

/** A JS error, or a request that finished with 4xx/5xx or failed outright (status 0). */
export function isFailure(e: NormalizedEvent): boolean {
  return e.kind === 'error' || (e.kind === 'request' && e.phase === 'end' && (e.status === 0 || e.status >= 400));
}

/** When a failure became visible: request failures at completion, errors when thrown. */
export function failureTime(e: NormalizedEvent): number {
  return e.kind === 'request' ? e.tEnd : e.t;
}

/** Stable text for a failure, used in fingerprints and issue details. Never contains user data. */
export function failureSignature(e: NormalizedEvent): string {
  if (e.kind === 'error') return e.signature;
  if (e.kind === 'request') return e.status === 0 ? `network error ${e.method} ${e.route}` : `HTTP ${e.status} ${e.method} ${e.route}`;
  return e.kind;
}

/**
 * Builds the "did the page react to this click?" test shared by the click detectors. A click is
 * answered by a mutation, navigation, request, or a change on the clicked control itself, landing in
 * [click.t, click.t + windowMs] (inclusive) and before the user's next click on a different element.
 *
 * Two things deliberately do not count, because they were caused by something else:
 * - whatever follows the next click elsewhere (pressing Checkout right after a dead Apply Coupon
 *   navigates, but that navigation answers Checkout);
 * - a change on another field, which rrweb records when that field loses focus (typing a code, then
 *   pressing Apply, emits the code field's change as the press begins).
 * Repeat clicks on the same element do not cut the window: a slow handler still answers them.
 */
export function responseCheck(stream: readonly NormalizedEvent[], windowMs: number): (click: ClickEvent) => boolean {
  const responses = stream.filter(isResponse);
  const clicks = stream.filter((e): e is ClickEvent => e.kind === 'click').sort((a, b) => a.t - b.t);
  return (click) => {
    const next = clicks.find((c) => c.t > click.t && c.nodeId !== click.nodeId);
    const end = Math.min(click.t + windowMs, next ? next.t - 1 : Number.POSITIVE_INFINITY);
    return responses.some((r) => r.t >= click.t && r.t <= end && (r.kind !== 'input' || r.nodeId === click.nodeId));
  };
}

/** True when some failure becomes visible in [t, t + windowMs]. */
export function failedWithin(failures: readonly NormalizedEvent[], t: number, windowMs: number): boolean {
  return failures.some((f) => failureTime(f) >= t && failureTime(f) <= t + windowMs);
}

/**
 * Decision-horizon rule shared by every click detector: an outcome due at `dueAt` is decided in the
 * chunk whose horizon first covers it, so it is decided exactly once across chunk boundaries.
 */
export function decidedNow(dueAt: number, prevHorizon: number | null, horizon: number): boolean {
  return dueAt > (prevHorizon ?? Number.NEGATIVE_INFINITY) && dueAt <= horizon;
}

/** Controls that open browser-native UI (no DOM change to observe), so silence is not evidence. */
const NATIVE_UI_TAGS = new Set(['select']);

/** Clicks whose silence means something: enabled, interactive, not native UI. */
export function isJudgeableClick(e: NormalizedEvent): e is ClickEvent {
  return e.kind === 'click' && e.interactive && !e.disabled && !(e.tag && NATIVE_UI_TAGS.has(e.tag));
}
