import { createHash } from 'node:crypto';
import { PriorityRuleSchema, TIERS, type Cluster, type FindingPriority, type PriorityRule, type RankOutput, type RevenueAtRisk, type Tier } from '@cp/schema';

/**
 * The priority rule set and the deterministic ranker (ARCHITECTURE.md section 5). Rules are versioned
 * data: the agent service records them in the `rules` table (kind builtin, type priority) and every
 * finding carries the rule set version it was ranked with. Code computes the base tier and the score;
 * the ranker agent may move the tier by at most one step, and only with a cited rule (rule 1).
 */

export const DEFAULT_PRIORITY_RULES: PriorityRule[] = [
  {
    id: 'checkout_blocker',
    version: 1,
    tier: 'P0',
    multiplier: 1,
    title: 'Checkout or payment blocker',
    description: 'Stops shoppers from placing an order or paying: a failing control on the checkout or payment route, usually with a JS error or failed request.',
    match: { kinds: ['element'], route_prefixes: ['/checkout', '/payment'], has_errors: true },
  },
  {
    id: 'pricing_error',
    version: 1,
    tier: 'P1',
    multiplier: 1,
    title: 'Pricing or total error',
    description: 'Shows a wrong price, total, discount, tax or shipping amount. Shoppers lose trust or are charged incorrectly even when nothing looks broken.',
    match: { kinds: ['invariant'] },
  },
  {
    id: 'checkout_friction',
    version: 1,
    tier: 'P2',
    multiplier: 1,
    title: 'Friction in the bag or checkout',
    description: 'A control in the bag or checkout that ignores or delays shoppers (for example a coupon or quantity button), where they can still finish the order.',
    match: { kinds: ['element'], route_prefixes: ['/cart', '/bag', '/checkout', '/payment'] },
  },
  {
    id: 'browse_friction',
    version: 1,
    tier: 'P3',
    multiplier: 1,
    title: 'Browse-page friction',
    description: 'Friction on browse, search or product pages, before the shopper has committed to a cart.',
    match: {},
  },
  {
    id: 'release_regression',
    version: 1,
    tier: null,
    multiplier: 1.5,
    title: 'Regression after a release',
    description: 'The issue first appeared right after a new release went out, so a recent change is the likely cause and a rollback may be quick.',
  },
];

export const TIER_WEIGHT: Record<Tier, number> = { P0: 1, P1: 0.75, P2: 0.5, P3: 0.25 };

/** Content hash of the rule set: changes whenever any rule or version changes. */
export function ruleSetVersion(rules: readonly PriorityRule[]): string {
  const canonical = [...rules].sort((a, b) => a.id.localeCompare(b.id)).map((r) => `${r.id}@${r.version}`);
  return `prs_${createHash('sha256').update(JSON.stringify(rules)).digest('hex').slice(0, 10)}:${canonical.join(',')}`.slice(0, 200);
}

export function parseRules(raw: unknown): PriorityRule[] {
  const rules = PriorityRuleSchema.array().min(1).parse(raw);
  if (!rules.some((r) => r.tier !== null && r.match)) throw new Error('the priority rule set needs at least one tier rule with a matcher');
  return rules;
}

export type ClusterFacts = Pick<Cluster, 'kind' | 'route' | 'error_signatures'>;

function matches(rule: PriorityRule, c: ClusterFacts): boolean {
  const m = rule.match;
  if (!m || rule.tier === null) return false;
  if (m.kinds && !m.kinds.includes(c.kind)) return false;
  if (m.route_prefixes && !m.route_prefixes.some((p) => c.route === p || c.route.startsWith(p.endsWith('/') ? p : `${p}/`))) return false;
  if (m.has_errors !== undefined && m.has_errors !== Object.keys(c.error_signatures).length > 0) return false;
  return true;
}

const tierIndex = (t: Tier) => TIERS.indexOf(t);

/** Deterministic base tier: the most urgent matching bucket (P3 when nothing matches). */
export function baseTier(c: ClusterFacts, rules: readonly PriorityRule[]): { tier: Tier; ruleIds: string[] } {
  const hits = rules.filter((r) => matches(r, c)).sort((a, b) => tierIndex(a.tier!) - tierIndex(b.tier!));
  return { tier: hits[0]?.tier ?? 'P3', ruleIds: hits.map((r) => r.id) };
}

/**
 * A regression: the issue's releases were all first seen shortly before the issue began, and an older
 * release exists in the window (with only one release ever seen there is nothing to regress from).
 */
export function isRegression(clusterReleases: readonly string[], firstSeen: number, releaseFirstSeen: ReadonlyMap<string, number>, windowMs: number): boolean {
  if (clusterReleases.length === 0) return false;
  const starts = clusterReleases.map((r) => releaseFirstSeen.get(r));
  if (starts.some((s) => s === undefined)) return false;
  const newest = Math.min(...(starts as number[]));
  const older = [...releaseFirstSeen.entries()].some(([r, t]) => !clusterReleases.includes(r) && t < newest);
  return older && starts.every((s) => firstSeen - s! <= windowMs && firstSeen >= s! - 60_000);
}

export interface RankResult {
  tier: Tier;
  priority: FindingPriority;
  score: number;
  /** Why a proposed move was not applied (null when applied or none proposed). */
  rejected: string | null;
}

/**
 * Final tier and score. The ranker output (if any) has already passed the grounding validator; here
 * the move is bounded to one step and checked against the cited rule's own tier.
 */
export function rank(
  c: ClusterFacts,
  revenue: RevenueAtRisk,
  rules: readonly PriorityRule[],
  opts: { regression: boolean; ranker: RankOutput | null },
): RankResult {
  const base = baseTier(c, rules);
  const byId = new Map(rules.map((r) => [r.id, r]));
  let move: -1 | 0 | 1 = 0;
  let moveRule: string | null = null;
  let rejected: string | null = null;
  const proposal = opts.ranker;
  if (proposal && proposal.tier_move !== 'none') {
    const rule = byId.get(proposal.move_rule_id);
    const want = proposal.tier_move === 'up' ? -1 : 1;
    const target = tierIndex(base.tier) + want;
    if (!rule) rejected = `move cites unknown rule "${proposal.move_rule_id}"`;
    else if (!proposal.rule_ids.includes(rule.id)) rejected = `move rule ${rule.id} is not among the cited rules`;
    else if (target < 0 || target >= TIERS.length) rejected = `already at ${base.tier}`;
    else if (rule.tier !== null && (want < 0 ? tierIndex(rule.tier) > target : tierIndex(rule.tier) < target)) {
      rejected = `rule ${rule.id} (${rule.tier}) does not support moving ${proposal.tier_move} from ${base.tier}`;
    } else {
      move = want;
      moveRule = rule.id;
    }
  }
  const tier = TIERS[tierIndex(base.tier) + move]!;
  const regressionRule = rules.find((r) => r.id === 'release_regression');
  const multiplier = opts.regression && regressionRule ? regressionRule.multiplier : 1;
  const cited = proposal ? proposal.rule_ids.filter((id) => byId.has(id)) : [];
  const score = Math.round((revenue.status === 'ok' ? revenue.revenue_at_risk_minor / 100 : 0) * TIER_WEIGHT[tier] * multiplier * 100) / 100;
  return {
    tier,
    score,
    rejected,
    priority: {
      rule_set_version: ruleSetVersion(rules),
      base_rule_ids: [...base.ruleIds, ...(multiplier !== 1 ? ['release_regression'] : [])],
      base_tier: base.tier,
      cited_rule_ids: cited,
      tier_move: move,
      move_rule_id: moveRule,
      regression: opts.regression,
      multiplier,
    },
  };
}
