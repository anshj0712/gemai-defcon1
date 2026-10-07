import { describe, expect, it } from 'vitest';
import { BUGS, makePlans, reachesTrigger, type Bug } from '../src/plan.js';
import { evaluate, type ClusterLike, type GroundTruth, type TruthSession } from '../src/truth.js';

describe('session plans', () => {
  const plans = makePlans(300, 42);

  it('is deterministic for a seed', () => {
    expect(makePlans(300, 42)).toEqual(plans);
    expect(makePlans(300, 43)).not.toEqual(plans);
  });

  it('follows the bug mix exactly', () => {
    const count = (b: Bug | null) => plans.filter((p) => p.bug === b).length;
    expect([count('dead_button'), count('cart_total'), count('checkout_error'), count(null)]).toEqual([60, 45, 45, 150]);
  });

  it('keeps the ground truth honest: affected plans reach their trigger, clean plans never do', () => {
    for (const p of plans) {
      if (p.bug) {
        expect(p.flags).toEqual([p.bug]);
        expect(reachesTrigger(p)).toBe(p.bug);
      } else {
        expect(reachesTrigger(p)).toBeNull();
      }
    }
  });

  it('includes near misses: clean sessions with a bug flag on', () => {
    const nearMisses = plans.filter((p) => p.bug === null && p.flags.length > 0);
    expect(nearMisses.length).toBeGreaterThan(40);
    for (const bug of BUGS) expect(nearMisses.some((p) => p.flags.includes(bug))).toBe(true);
  });

  it('makes affected shoppers abandon more often than the baseline', () => {
    const rate = (f: (b: Bug | null) => boolean) => {
      const group = plans.filter((p) => f(p.bug) && p.persona !== 'window_shopper');
      return group.filter((p) => p.abandon).length / group.length;
    };
    expect(rate((b) => b !== null)).toBeGreaterThan(rate((b) => b === null) + 0.2);
  });
});

describe('evaluate', () => {
  const s = (index: number, bug: Bug | null, extra: Partial<TruthSession> = {}): TruthSession => ({
    index,
    session_id: `s_${index}`,
    persona: bug ? 'coupon_hunter' : 'buyer',
    bug,
    flags: bug ? [bug] : [],
    has_cart: true,
    cart_value_minor: 1000,
    currency: 'INR',
    order_placed: false,
    abandoned: true,
    sample_rate: 1,
    started_at: 0,
    ended_at: 1,
    ...extra,
  });
  const truth = (sessions: TruthSession[]): GroundTruth => ({
    v: 1,
    synthetic: true,
    tenant_id: 'demo',
    seed: 1,
    started_at: 0,
    finished_at: 1,
    config: { mix: { dead_button: 0, cart_total: 0, checkout_error: 0 }, abandonment: { baseline: 0, dead_button: 0, cart_total: 0, checkout_error: 0 }, windowShoppers: 0, nearMiss: 0 },
    sessions,
  });
  const c = (id: string, sessions: string[]): ClusterLike => ({ cluster_id: id, title: id, kind: 'element', anchor: 'a', route: '/', sessions, detectors: {} });

  const sessions = [s(1, 'dead_button'), s(2, 'dead_button'), s(3, 'cart_total'), s(4, null, { abandoned: false, order_placed: true }), s(5, null)];

  it('passes when each bug is one issue and clean sessions are in none', () => {
    const r = evaluate(truth(sessions), [c('dead', ['s_1', 's_2', 'other_run']), c('total', ['s_3'])]);
    expect(r.pass).toBe(true);
    expect(r.bugs.find((b) => b.bug === 'dead_button')).toMatchObject({ affected: 2, clusters: 1, recall: 1, precision: 1, cluster_id: 'dead' });
    expect(r.abandonment.find((a) => a.group === 'baseline')).toMatchObject({ with_cart: 2, abandoned: 1, rate: 0.5 });
  });

  it('fails on a split bug, a leaked clean session, low recall, and stray issues', () => {
    const r = evaluate(truth(sessions), [c('dead', ['s_1', 's_5']), c('dead2', ['s_2']), c('stray', ['s_4'])]);
    expect(r.pass).toBe(false);
    expect(r.failures.join('\n')).toMatch(/dead_button: expected 1 issue, found 2/);
    expect(r.failures.join('\n')).toMatch(/cart_total: recall 0.0%/);
    expect(r.clean_in_clusters.sort()).toEqual(['s_4', 's_5']);
    expect(r.unexpected_clusters.map((u) => u.cluster_id)).toEqual(['stray']);
  });

  it('leaves failed browser runs out of scoring', () => {
    const r = evaluate(truth([...sessions, s(6, 'cart_total', { error: 'timed out' })]), [c('dead', ['s_1', 's_2']), c('total', ['s_3'])]);
    expect(r).toMatchObject({ pass: true, scored_sessions: 5, failed_sessions: 1 });
  });
});

describe('Phase 3 exit test (findings)', async () => {
  const { evaluateFindings } = await import('../src/truth.js');
  const bug = (b: Bug, cluster_id: string | null) => ({ bug: b, affected: 3, clusters: 1, cluster_id, title: 't', recall: 1, precision: 1 });
  const finding = (over: object = {}) => ({
    finding_id: 'c1', cluster_id: 'c1', title: 'Coupon', tier: 'P2', status: 'open', model_version: 'offline-stand-in',
    triage: { summary: { text: 's' }, repro_steps: [{ step: 'a' }, { step: 'b' }] },
    revenue: { status: 'ok', revenue_at_risk_minor: 100, currency: 'INR', abandonment_affected: 0.6, abandonment_baseline: 0.25 },
    evidence: [{ id: 'E2', kind: 'signal', session_id: 's1', signal_id: 'g1' }],
    ...over,
  });

  it('passes a finding with a summary, two steps, and a replay link', () => {
    const r = evaluateFindings([bug('dead_button', 'c1')], new Map([['c1', finding()]]));
    expect(r.failures).toEqual([]);
    expect(r.scores[0]).toMatchObject({ tier: 'P2', repro_steps: 2, replay_link: { session_id: 's1', signal_id: 'g1' } });
  });

  it('fails a missing finding, a missing analysis, and a finding without replay evidence', () => {
    expect(evaluateFindings([bug('dead_button', 'c1')], new Map()).failures[0]).toMatch(/no finding/);
    expect(evaluateFindings([bug('dead_button', 'c1')], new Map([['c1', finding({ triage: null })]])).failures).toHaveLength(2);
    expect(evaluateFindings([bug('dead_button', 'c1')], new Map([['c1', finding({ evidence: [] })]])).failures[0]).toMatch(/replay/);
  });
});
