import { describe, expect, it } from 'vitest';
import type { RankOutput, RevenueAtRisk } from '@cp/schema';
import { baseTier, DEFAULT_PRIORITY_RULES, isRegression, parseRules, rank, revenueAtRisk, ruleSetVersion, type RevenueParams } from '../src/scoring/index.js';
import { demoClusters, outcome, T } from './helpers.js';

const params: RevenueParams = { abandonAfterIdleMs: 120_000, minBaselineSessions: 5, minAffectedDecided: 3 };
const NOW = T + 10 * 60_000; // every session idle for long enough to be decided

/** 10 affected (6 abandon) and 20 baseline on /cart (5 abandon): synthetic. */
function scenario() {
  const affected = Array.from({ length: 10 }, (_, i) => outcome(`s_aff_${i}`, { ordered: i >= 6 }));
  const baseline = Array.from({ length: 20 }, (_, i) => outcome(`s_base_${i}`, { ordered: i >= 5, routes: ['/', '/cart'] }));
  return { affected, baseline };
}

describe('revenue at risk', () => {
  it('is N x V x (a_affected - a_baseline), never counting baseline abandonment', () => {
    const { affected, baseline } = scenario();
    const r = revenueAtRisk(
      { affectedSessionIds: affected.map((o) => o.session_id), affectedSessionCount: 10, route: '/cart', sessionsInAnyIssue: new Set(affected.map((o) => o.session_id)), outcomes: [...affected, ...baseline], now: NOW },
      params,
    );
    expect(r).toMatchObject({ status: 'ok', baseline_scope: 'route', abandonment_affected: 0.6, abandonment_baseline: 0.25, avg_cart_value_minor: 1_000_000, currency: 'INR' });
    // 10 sessions x ₹10,000 x (0.60 - 0.25) = ₹35,000
    expect(r.revenue_at_risk_minor).toBe(3_500_000);
  });

  it('is zero, not negative, when affected shoppers abandon less than the baseline', () => {
    const affected = Array.from({ length: 5 }, (_, i) => outcome(`s_aff_${i}`, { ordered: true }));
    const baseline = Array.from({ length: 10 }, (_, i) => outcome(`s_base_${i}`, { ordered: i % 2 === 0 }));
    const r = revenueAtRisk({ affectedSessionIds: affected.map((o) => o.session_id), affectedSessionCount: 5, route: '/cart', sessionsInAnyIssue: new Set(), outcomes: [...affected, ...baseline], now: NOW }, params);
    expect(r.status).toBe('ok');
    expect(r.revenue_at_risk_minor).toBe(0);
  });

  it('keeps sessions from other issues out of the baseline', () => {
    const { affected, baseline } = scenario();
    const otherIssue = Array.from({ length: 20 }, (_, i) => outcome(`s_other_${i}`, { ordered: false }));
    const r = revenueAtRisk(
      {
        affectedSessionIds: affected.map((o) => o.session_id),
        affectedSessionCount: 10,
        route: '/cart',
        sessionsInAnyIssue: new Set([...affected, ...otherIssue].map((o) => o.session_id)),
        outcomes: [...affected, ...baseline, ...otherIssue],
        now: NOW,
      },
      params,
    );
    expect(r.abandonment_baseline).toBe(0.25);
  });

  it('re-weights by sample rate and scales past the cluster session cap', () => {
    const affected = Array.from({ length: 4 }, (_, i) => outcome(`s_aff_${i}`, { ordered: i === 0, sample_rate: 0.5 }));
    const baseline = Array.from({ length: 10 }, (_, i) => outcome(`s_base_${i}`, { ordered: true }));
    const r = revenueAtRisk({ affectedSessionIds: affected.map((o) => o.session_id), affectedSessionCount: 8, route: '/cart', sessionsInAnyIssue: new Set(), outcomes: [...affected, ...baseline], now: NOW }, params);
    // 4 sessions at rate 0.5 stand for 8; the cluster counted 8 but listed 4, so x2 again.
    expect(r.affected_with_cart).toBe(16);
    expect(r.revenue_at_risk_minor).toBe(Math.round(16 * 1_000_000 * 0.75));
  });

  it('waits for outcomes: sessions still active are pending, not abandoned', () => {
    const affected = Array.from({ length: 5 }, (_, i) => outcome(`s_aff_${i}`, { last_seen: NOW - 10_000 }));
    const r = revenueAtRisk({ affectedSessionIds: affected.map((o) => o.session_id), affectedSessionCount: 5, route: '/cart', sessionsInAnyIssue: new Set(), outcomes: affected, now: NOW }, params);
    expect(r).toMatchObject({ status: 'insufficient_data', revenue_at_risk_minor: 0, pending: 5 });
  });

  it('widens the baseline to all routes when the issue route has too few sessions', () => {
    const { affected } = scenario();
    const elsewhere = Array.from({ length: 10 }, (_, i) => outcome(`s_else_${i}`, { routes: ['/'], ordered: i >= 2 }));
    const r = revenueAtRisk({ affectedSessionIds: affected.map((o) => o.session_id), affectedSessionCount: 10, route: '/cart', sessionsInAnyIssue: new Set(), outcomes: [...affected, ...elsewhere], now: NOW }, params);
    expect(r).toMatchObject({ baseline_scope: 'all', abandonment_baseline: 0.2 });
    expect(r.note).toMatch(/widened/);
  });
});

const okRevenue = { status: 'ok', revenue_at_risk_minor: 3_500_000 } as RevenueAtRisk;
const rankOut = (over: Partial<RankOutput>): RankOutput => ({ rule_ids: ['checkout_friction'], tier_move: 'none', move_rule_id: '', reason: { text: 'x', evidence_ids: ['E1'] }, ...over });

describe('priority rules and ranking', () => {
  const { dead, total, checkout } = demoClusters(3);

  it('gives the three demo bugs their base tiers deterministically', () => {
    expect(baseTier(checkout, DEFAULT_PRIORITY_RULES).tier).toBe('P0');
    expect(baseTier(total, DEFAULT_PRIORITY_RULES).tier).toBe('P1');
    expect(baseTier(dead, DEFAULT_PRIORITY_RULES)).toMatchObject({ tier: 'P2', ruleIds: ['checkout_friction', 'browse_friction'] });
  });

  it('scores revenue at risk x tier weight', () => {
    expect(rank(dead, okRevenue, DEFAULT_PRIORITY_RULES, { regression: false, ranker: null }).score).toBe(17_500);
    expect(rank(checkout, okRevenue, DEFAULT_PRIORITY_RULES, { regression: false, ranker: null }).score).toBe(35_000);
    const reg = rank(dead, okRevenue, DEFAULT_PRIORITY_RULES, { regression: true, ranker: null });
    expect(reg.score).toBe(26_250);
    expect(reg.priority.base_rule_ids).toContain('release_regression');
  });

  it('applies a one-tier move only when the cited rule supports it', () => {
    const up = rank(dead, okRevenue, DEFAULT_PRIORITY_RULES, { regression: false, ranker: rankOut({ rule_ids: ['pricing_error'], tier_move: 'up', move_rule_id: 'pricing_error' }) });
    expect(up).toMatchObject({ tier: 'P1', rejected: null, priority: { base_tier: 'P2', tier_move: -1, move_rule_id: 'pricing_error' } });

    // checkout_friction is itself P2: it cannot justify moving a P2 finding up.
    const unsupported = rank(dead, okRevenue, DEFAULT_PRIORITY_RULES, { regression: false, ranker: rankOut({ tier_move: 'up', move_rule_id: 'checkout_friction' }) });
    expect(unsupported.tier).toBe('P2');
    expect(unsupported.rejected).toMatch(/does not support/);

    // A P0 rule still moves a P2 finding by one tier only.
    const capped = rank(dead, okRevenue, DEFAULT_PRIORITY_RULES, { regression: false, ranker: rankOut({ rule_ids: ['checkout_blocker'], tier_move: 'up', move_rule_id: 'checkout_blocker' }) });
    expect(capped.tier).toBe('P1');

    const unknown = rank(dead, okRevenue, DEFAULT_PRIORITY_RULES, { regression: false, ranker: rankOut({ rule_ids: ['vip'], tier_move: 'up', move_rule_id: 'vip' }) });
    expect(unknown).toMatchObject({ tier: 'P2', rejected: expect.stringMatching(/unknown rule/) });

    const top = rank(checkout, okRevenue, DEFAULT_PRIORITY_RULES, { regression: false, ranker: rankOut({ rule_ids: ['checkout_blocker'], tier_move: 'up', move_rule_id: 'checkout_blocker' }) });
    expect(top).toMatchObject({ tier: 'P0', rejected: 'already at P0' });
  });

  it('versions the rule set by content', () => {
    const changed = DEFAULT_PRIORITY_RULES.map((r) => (r.id === 'pricing_error' ? { ...r, version: 2 } : r));
    expect(ruleSetVersion(changed)).not.toBe(ruleSetVersion(DEFAULT_PRIORITY_RULES));
    expect(() => parseRules([{ id: 'x_rule', version: 1, tier: null, title: 't', description: 'd' }])).toThrow(/tier rule/);
  });

  it('calls a regression only when an older release exists and the issue began right after the new one', () => {
    const firstSeen = new Map([
      ['v1', T - 5 * 86_400_000],
      ['v2', T - 3_600_000],
    ]);
    expect(isRegression(['v2'], T, firstSeen, 24 * 3_600_000)).toBe(true);
    expect(isRegression(['v1'], T, firstSeen, 24 * 3_600_000)).toBe(false);
    expect(isRegression(['v2'], T, new Map([['v2', T - 3_600_000]]), 24 * 3_600_000)).toBe(false);
  });
});
