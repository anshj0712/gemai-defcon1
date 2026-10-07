import type { SessionOutcome } from '@cp/platform';
import type { RevenueAtRisk } from '@cp/schema';

/**
 * Revenue at risk (AGENTS.md rule 9, ARCHITECTURE.md section 5):
 *
 *   RaR = N_affected x V_cart x (a_affected - a_baseline)
 *
 * N is affected sessions that had a cart, V their average cart value, and a the abandonment rate of
 * affected versus unaffected (baseline) sessions. Using the difference never counts baseline
 * abandonment as lost revenue. Every count is weighted by 1 / sample_rate so a sampled session stands
 * for the sessions the SDK did not ship. Pure: no I/O, no clocks (`now` is passed in).
 */

export interface RevenueParams {
  /** A session's outcome counts once it has been idle this long: abandoned without an order, else converted. */
  abandonAfterIdleMs: number;
  /** Fewer decided baseline sessions than this on the issue's route widens the baseline to all routes. */
  minBaselineSessions: number;
  /** Fewer decided affected sessions than this gives no estimate (status insufficient_data). */
  minAffectedDecided: number;
}

export const DEFAULT_REVENUE_PARAMS: RevenueParams = { abandonAfterIdleMs: 120_000, minBaselineSessions: 20, minAffectedDecided: 3 };

export interface RevenueInput {
  /** The cluster's listed affected sessions (capped at its session list limit). */
  affectedSessionIds: readonly string[];
  /** The cluster's true affected count; above the list length, counts are scaled up proportionally. */
  affectedSessionCount: number;
  /** Route of the issue, for a like-for-like baseline. */
  route: string;
  /** Sessions in any issue: never part of a baseline. */
  sessionsInAnyIssue: ReadonlySet<string>;
  outcomes: readonly SessionOutcome[];
  now: number;
}

const weight = (o: SessionOutcome) => (o.sample_rate && o.sample_rate > 0 ? 1 / o.sample_rate : 1);
const hasCart = (o: SessionOutcome) => o.cart_value_minor !== null && o.cart_value_minor > 0;

interface Tally {
  withCart: number;
  decided: number;
  abandoned: number;
  pending: number;
  cartValueSum: number;
}

function tally(sessions: readonly SessionOutcome[], currency: string | null, params: RevenueParams, now: number): Tally {
  const t: Tally = { withCart: 0, decided: 0, abandoned: 0, pending: 0, cartValueSum: 0 };
  for (const o of sessions) {
    if (!hasCart(o) || (currency !== null && o.currency !== null && o.currency !== currency)) continue;
    const w = weight(o);
    t.withCart += w;
    t.cartValueSum += w * o.cart_value_minor!;
    // A session counts once it has gone quiet, ordered or not. Counting orders as soon as they happen
    // but abandonment only after the idle window would bias early rates towards zero.
    if (now - o.last_seen < params.abandonAfterIdleMs) t.pending += w;
    else {
      t.decided += w;
      if (!o.ordered) t.abandoned += w;
    }
  }
  return t;
}

/** The currency most affected carts use (one estimate per currency; others are left out). */
function mainCurrency(sessions: readonly SessionOutcome[]): string | null {
  const counts = new Map<string, number>();
  for (const o of sessions) if (hasCart(o) && o.currency) counts.set(o.currency, (counts.get(o.currency) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const rate = (abandoned: number, decided: number) => (decided > 0 ? abandoned / decided : null);

export function revenueAtRisk(input: RevenueInput, params: RevenueParams = DEFAULT_REVENUE_PARAMS): RevenueAtRisk {
  const affectedIds = new Set(input.affectedSessionIds);
  const affected = input.outcomes.filter((o) => affectedIds.has(o.session_id));
  const currency = mainCurrency(affected);
  // The cluster lists up to 5,000 sessions but keeps counting; scale the listed ones up to the true count.
  const scale = affectedIds.size > 0 ? Math.max(1, input.affectedSessionCount / affectedIds.size) : 1;

  const a = tally(affected, currency, params, input.now);
  const unaffected = input.outcomes.filter((o) => !input.sessionsInAnyIssue.has(o.session_id) && !affectedIds.has(o.session_id));
  const onRoute = unaffected.filter((o) => o.routes.includes(input.route));
  let scope: RevenueAtRisk['baseline_scope'] = 'route';
  let b = tally(onRoute, currency, params, input.now);
  if (b.decided < params.minBaselineSessions) {
    scope = 'all';
    b = tally(unaffected, currency, params, input.now);
  }
  if (b.decided === 0) scope = 'none';

  const aRate = rate(a.abandoned, a.decided);
  const bRate = rate(b.abandoned, b.decided);
  const avg = a.withCart > 0 ? Math.round(a.cartValueSum / a.withCart) : null;
  const base = {
    currency,
    affected_with_cart: round2(a.withCart * scale),
    affected_decided: round2(a.decided * scale),
    affected_abandoned: round2(a.abandoned * scale),
    abandonment_affected: aRate === null ? null : round2(aRate * 1000) / 1000,
    baseline_decided: round2(b.decided),
    baseline_abandoned: round2(b.abandoned),
    abandonment_baseline: bRate === null ? null : round2(bRate * 1000) / 1000,
    baseline_scope: scope,
    avg_cart_value_minor: avg,
    pending: round2(a.pending * scale),
  };

  const insufficient = (note: string): RevenueAtRisk => ({ ...base, revenue_at_risk_minor: 0, status: 'insufficient_data', note });
  if (a.withCart === 0) return insufficient('No affected session had a cart yet.');
  if (a.decided < params.minAffectedDecided) return insufficient(`Waiting for outcomes: ${round2(a.decided)} affected sessions with a cart have finished.`);
  if (aRate === null || bRate === null) return insufficient('No finished baseline sessions with a cart to compare against.');

  const lift = Math.max(0, aRate - bRate);
  const rar = Math.round(a.withCart * scale * avg! * lift);
  const note =
    lift === 0
      ? 'Affected shoppers abandon no more often than the baseline, so no revenue is attributed to this issue.'
      : scope === 'all'
        ? `Baseline widened to all routes: fewer than ${params.minBaselineSessions} finished unaffected sessions on ${input.route}.`
        : null;
  return { ...base, revenue_at_risk_minor: rar, status: 'ok', note };
}
