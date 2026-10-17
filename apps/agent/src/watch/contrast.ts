import type { SessionOutcome } from '@cp/platform';
import type { SegmentStats, WatchFeature } from '@cp/schema';

/**
 * The churn watcher's statistics (deterministic, AGENTS.md rule 1: code decides, Gemini judges and words it).
 * For one number a session reports (a probe, or a page element nobody probes yet), find the threshold where
 * shoppers past it abandon their cart far more often than everyone else, and check the gap is not chance.
 * The baseline is the same as revenue at risk's (rule 9): decided sessions with a cart that are neither in
 * the segment nor in any issue.
 */

export interface WatchParams {
  /** Fewest decided cart sessions a segment may hold. */
  minSegment: number;
  /** Segment abandonment minus baseline abandonment, at least. */
  minLift: number;
  /** One-sided p-value of the gap, at most (strict: many numbers are tried). */
  maxP: number;
  /** A segment holding more than this share of decided cart sessions is "everyone", not a segment. */
  maxShare: number;
  /** Skip a segment when this share of it is already in an issue (detection already explains it). */
  maxExplained: number;
  /** Two segments sharing this much (Jaccard) are one finding. */
  overlap: number;
  /** Most segments one pass hands to the analyst. */
  maxCandidates: number;
  /**
   * The segment must stand apart: its smallest value at least this many times the largest value outside it (a
   * fee that appears, a 6.5 s wait against 0.3 s). The watcher hunts defects, not trends, so a slope (bigger carts
   * abandon a bit more) is not a candidate.
   */
  minSeparation: number;
  /** Fewest baseline sessions a comparison may rest on. */
  minBaseline: number;
}

export const DEFAULT_WATCH_PARAMS: WatchParams = { minSegment: 6, minLift: 0.3, maxP: 0.01, maxShare: 0.6, maxExplained: 0.5, overlap: 0.8, maxCandidates: 3, minSeparation: 1.5, minBaseline: 12 };

/** A decided session with a cart: did the shopper leave without ordering, and which pages did they reach? */
export interface Decided {
  abandoned: boolean;
  cartValueMinor: number;
  routes?: readonly string[];
}

/** Sessions with a cart that are still inside the abandonment window (their outcome is not known yet). */
export function pendingCartSessions(outcomes: readonly SessionOutcome[], now: number, abandonAfterIdleMs: number): Set<string> {
  return new Set(outcomes.filter((o) => o.cart_value_minor !== null && o.cart_value_minor > 0 && now - o.last_seen < abandonAfterIdleMs).map((o) => o.session_id));
}

/** Sessions whose cart outcome is settled: a cart, and quiet for the abandonment window (ordered or not). */
export function decidedSessions(outcomes: readonly SessionOutcome[], now: number, abandonAfterIdleMs: number): Map<string, Decided> {
  const out = new Map<string, Decided>();
  for (const o of outcomes) {
    if (o.cart_value_minor === null || o.cart_value_minor <= 0) continue;
    if (now - o.last_seen < abandonAfterIdleMs) continue;
    out.set(o.session_id, { abandoned: !o.ordered, cartValueMinor: o.cart_value_minor, routes: o.routes });
  }
  return out;
}

export interface Segment {
  feature: WatchFeature;
  direction: 'gte' | 'lte';
  threshold: number;
  /** Decided cart sessions in the segment. */
  sessionIds: string[];
  segment: SegmentStats;
  baseline: SegmentStats;
  lift: number;
  z: number;
  p: number;
  /** Share of the segment already in an issue. */
  explained: number;
  /** Sessions kept out of the baseline because another suspected number explains them (not serialized). */
  explainedElsewhere?: ReadonlySet<string>;
  /** Shoppers past the threshold whose cart has not settled yet (the watcher waits while there are many). */
  pending: number;
  values: { segment_min: number; segment_max: number; others_max: number | null; others_median: number | null };
}

/** Standard normal upper tail, P(Z > z) (Abramowitz and Stegun 7.1.26 via erfc). */
export function upperTail(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}

const stats = (ids: Iterable<string>, decided: ReadonlyMap<string, Decided>): SegmentStats => {
  let sessions = 0;
  let abandoned = 0;
  for (const id of ids) {
    const d = decided.get(id);
    if (!d) continue;
    sessions += 1;
    if (d.abandoned) abandoned += 1;
  }
  return { sessions, abandoned, abandonment: sessions ? abandoned / sessions : 0 };
};

/** One-sided two-proportion z-test that the segment abandons more than the baseline. */
function zTest(s: SegmentStats, b: SegmentStats): { z: number; p: number } {
  if (s.sessions === 0 || b.sessions === 0) return { z: 0, p: 1 };
  const pooled = (s.abandoned + b.abandoned) / (s.sessions + b.sessions);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / s.sessions + 1 / b.sessions));
  if (se === 0) return { z: s.abandonment > b.abandonment ? Infinity : 0, p: s.abandonment > b.abandonment ? 0 : 1 };
  const z = (s.abandonment - b.abandonment) / se;
  return { z, p: upperTail(z) };
}

/** Most thresholds tried per number (quantile cut points beyond this). */
const MAX_THRESHOLDS = 40;

/**
 * The best segment for one number: per session its value (the session's largest), over decided cart sessions.
 * Returns null when no threshold passes the bar.
 */
export function bestSegment(
  feature: WatchFeature,
  values: ReadonlyMap<string, number>,
  decided: ReadonlyMap<string, Decided>,
  inIssues: ReadonlySet<string>,
  params: WatchParams,
  /** Shoppers another suspected number explains: left out of the baseline, not counted as explained. */
  explainedElsewhere: ReadonlySet<string> = new Set(),
  /** Sessions with a cart that has not settled yet. */
  pendingCarts: ReadonlySet<string> = new Set(),
): Segment | null {
  const present = [...values.entries()].filter(([id]) => decided.has(id));
  if (present.length < params.minSegment) return null;
  const distinct = [...new Set(present.map(([, v]) => v))].sort((a, b) => a - b);
  const cuts = distinct.length <= MAX_THRESHOLDS ? distinct : Array.from({ length: MAX_THRESHOLDS }, (_, i) => distinct[Math.floor((i * distinct.length) / MAX_THRESHOLDS)]!);
  const everyone = decided.size;
  // Like for like: the baseline is shoppers who reached the number's page (checkout for a checkout fee), so a
  // segment is not compared against people who never got that far. Everyone, when too few did.
  const reached = feature.route ? [...decided].filter(([, d]) => d.routes?.includes(feature.route!)).map(([id]) => id) : [];
  const pool = reached.length >= params.minSegment * 2 ? reached : [...decided.keys()];
  let best: Segment | null = null;
  for (const direction of ['gte', 'lte'] as const) {
    for (const t of cuts) {
      const ids = present.filter(([, v]) => (direction === 'gte' ? v >= t : v <= t)).map(([id]) => id);
      if (ids.length < params.minSegment || ids.length > params.maxShare * everyone) continue;
      // A step, not a slope: the segment's values stand apart from everyone else's.
      const outside = present.filter(([, v]) => (direction === 'gte' ? v < t : v > t)).map(([, v]) => v);
      if (outside.length > 0) {
        const apart = direction === 'gte' ? t >= params.minSeparation * Math.max(...outside) : Math.min(...outside) >= params.minSeparation * t;
        if (!apart) continue;
      }
      const inSeg = new Set(ids);
      const baselineIds = pool.filter((id) => !inSeg.has(id) && !inIssues.has(id) && !explainedElsewhere.has(id));
      const s = stats(ids, decided);
      const b = stats(baselineIds, decided);
      if (b.sessions < params.minBaseline) continue;
      const lift = s.abandonment - b.abandonment;
      if (lift < params.minLift) continue;
      const { z, p } = zTest(s, b);
      if (p > params.maxP) continue;
      if (best && !(z > best.z || (z === best.z && ids.length > best.sessionIds.length))) continue;
      const segVals = ids.map((id) => values.get(id)!);
      const others = present.filter(([id]) => !inSeg.has(id)).map(([, v]) => v).sort((a, b2) => a - b2);
      best = {
        feature,
        direction,
        threshold: t,
        sessionIds: ids,
        segment: s,
        baseline: b,
        lift,
        z,
        p,
        explained: ids.filter((id) => inIssues.has(id)).length / ids.length,
        ...(explainedElsewhere.size > 0 ? { explainedElsewhere } : {}),
        pending: [...values].filter(([id, v]) => pendingCarts.has(id) && (direction === 'gte' ? v >= t : v <= t)).length,
        values: {
          segment_min: Math.min(...segVals),
          segment_max: Math.max(...segVals),
          others_max: others.length ? others[others.length - 1]! : null,
          others_median: others.length ? others[Math.floor(others.length / 2)]! : null,
        },
      };
    }
  }
  return best;
}

const jaccard = (a: readonly string[], b: readonly string[]) => {
  const sb = new Set(b);
  const inter = a.filter((x) => sb.has(x)).length;
  return inter / (a.length + b.length - inter || 1);
};

/** Existing probes beat a page element (no new probe needed); then requests, then declared ones. */
const SOURCE_RANK: Record<WatchFeature['source'], number> = { recorded: 0, request: 0, declared: 1, discovered: 2 };

/**
 * Segments worth asking the analyst about, strongest first: each number's best segment, minus those detection
 * already explains, merged when they are the same shoppers (a request's _ms and _status, or two selectors for
 * one element), at most `maxCandidates`.
 *
 * Two passes, so silent problems do not hide each other: several can hurt shoppers at once (a fee, a slow bank, a
 * slow page), none of them in an issue, and each would sit in the others' baselines and make them look normal. A
 * loose first pass finds every suspicious segment; the final pass judges each number against shoppers that no
 * other suspected number explains.
 */
/**
 * The loose first pass: every segment that might be a problem (half the lift, p at most 0.2, still a step). Generous
 * on purpose: it only decides which shoppers stay out of baselines, here and in revenue at risk.
 */
export function looseSuspects(
  numbers: ReadonlyMap<string, { feature: WatchFeature; values: ReadonlyMap<string, number> }>,
  decided: ReadonlyMap<string, Decided>,
  inIssues: ReadonlySet<string>,
  params: WatchParams,
): Segment[] {
  const loose: WatchParams = { ...params, minLift: params.minLift / 2, maxP: 0.2 };
  const suspects: Segment[] = [];
  for (const { feature, values } of numbers.values()) {
    const seg = bestSegment(feature, values, decided, inIssues, loose);
    if (seg && seg.explained < params.maxExplained) suspects.push(seg);
  }
  return suspects;
}

export function findSegments(
  numbers: ReadonlyMap<string, { feature: WatchFeature; values: ReadonlyMap<string, number> }>,
  decided: ReadonlyMap<string, Decided>,
  inIssues: ReadonlySet<string>,
  params: WatchParams,
  pendingCarts: ReadonlySet<string> = new Set(),
  suspects: readonly Segment[] = looseSuspects(numbers, decided, inIssues, params),
): Segment[] {
  const found: Segment[] = [];
  for (const { feature, values } of numbers.values()) {
    const mine = suspects.find((s) => s.feature.key === feature.key);
    const elsewhere = new Set<string>();
    for (const s of suspects) {
      if (s.feature.key === feature.key) continue;
      // A twin (the same shoppers under another number) is this problem, not another one.
      if (mine && jaccard(s.sessionIds, mine.sessionIds) >= params.overlap) continue;
      for (const id of s.sessionIds) elsewhere.add(id);
    }
    const seg = bestSegment(feature, values, decided, inIssues, params, elsewhere, pendingCarts);
    if (seg && seg.explained < params.maxExplained) found.push(seg);
  }
  found.sort((a, b) => b.z - a.z || SOURCE_RANK[a.feature.source] - SOURCE_RANK[b.feature.source] || b.sessionIds.length - a.sessionIds.length || a.feature.key.localeCompare(b.feature.key));
  const kept: Segment[] = [];
  for (const seg of found) {
    const twin = kept.findIndex((k) => jaccard(k.sessionIds, seg.sessionIds) >= params.overlap);
    if (twin < 0) kept.push(seg);
    // Same shoppers, but an existing probe needs no new one: prefer it when it is about as strong.
    else if (SOURCE_RANK[seg.feature.source] < SOURCE_RANK[kept[twin]!.feature.source] && seg.z >= kept[twin]!.z * 0.8) kept[twin] = seg;
  }
  return kept.slice(0, params.maxCandidates);
}

/** Two significant figures, rounded down (3,456 -> 3,400; 0 stays 0). */
function floor2(n: number): number {
  if (n <= 0) return 0;
  const mag = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
  return Math.floor(n / mag) * mag;
}

/**
 * A limit a rule can use: past every value outside the segment and short of the segment's own values, so in this
 * window it flags exactly the segment. Halfway between, rounded for a person to read. With nothing outside the
 * segment (the number only shows up for these shoppers, a fee for example), 0.
 */
export function suggestedLimit(seg: Pick<Segment, 'direction' | 'threshold' | 'values' | 'feature'>): number {
  const { others_max } = seg.values;
  if (seg.direction === 'lte') {
    // Rare (a number too low): the limit sits between the segment's top and the lowest value outside it.
    return Math.ceil(seg.threshold + 1);
  }
  if (others_max === null) return 0;
  const mid = (others_max + seg.threshold) / 2;
  const unit = seg.feature.unit;
  const rounded = unit === 'ms' ? floor2(mid) : unit === 'money' ? Math.floor(mid / 100) * 100 : Math.floor(mid);
  return Math.max(others_max, Math.min(rounded, seg.threshold - (unit === 'money' ? 100 : 1)));
}
