import { describe, expect, it } from 'vitest';
import { BUGS, makePlans, pressesRemove, reachesTrigger, SUGGESTED_RULE_BUGS, type Bug } from '../src/plan.js';
import { evaluate, evaluateRetro, type ClusterLike, type GroundTruth, type TruthSession } from '../src/truth.js';

describe('session plans', () => {
  const plans = makePlans(300, 42);

  it('is deterministic for a seed', () => {
    expect(makePlans(300, 42)).toEqual(plans);
    expect(makePlans(300, 43)).not.toEqual(plans);
  });

  it('follows the bug mix exactly', () => {
    const count = (b: Bug | null) => plans.filter((p) => p.bug === b).length;
    expect([count('dead_button'), count('cart_total'), count('checkout_error'), count('qty_price'), count('ghost_line'), count(null)]).toEqual([60, 45, 45, 30, 30, 90]);
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

  it('keeps quantities at 1 whenever qty_price is on and the session is clean (a quantity of 2 is its trigger)', () => {
    const near = plans.filter((p) => p.bug === null && p.flags.includes('qty_price'));
    expect(near.length).toBeGreaterThan(0);
    for (const p of near) expect(p.qtyIncrements).toBe(0);
    for (const p of plans.filter((x) => x.bug === 'qty_price')) expect(p).toMatchObject({ persona: 'pair_buyer', codes: [], incrementFirstLine: true });
  });

  it('sends ghost_line sessions to Remove, and never lets a clean session press it', () => {
    const ghost = plans.filter((p) => p.bug === 'ghost_line');
    expect(ghost.length).toBe(30);
    for (const p of ghost) {
      expect(p).toMatchObject({ persona: 'line_remover', flags: ['ghost_line'], codes: [], qtyIncrements: 0 });
      expect(pressesRemove(p)).toBe(true);
      expect(reachesTrigger(p)).toBe('ghost_line');
      expect([2, 3]).toContain(p.removePresses);
      // Two distinct products: Remove takes the last, and the first keeps the bag's value above zero.
      expect(p.products).toHaveLength(2);
      expect(new Set(p.products.map((x) => x.id)).size).toBe(2);
      if (p.abandon) expect(p.abandonAt).toBe('bag');
    }
    expect(new Set(ghost.map((p) => p.removePresses)).size).toBe(2);
    for (const p of plans.filter((x) => x.bug !== 'ghost_line')) {
      expect(pressesRemove(p)).toBe(false);
      expect(p.removePresses).toBe(0);
    }
    // Near misses: ghost_line on, but nobody presses Remove, so the session stays clean.
    expect(plans.some((p) => p.bug === null && p.flags.includes('ghost_line'))).toBe(true);
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
    config: {
      mix: { dead_button: 0, cart_total: 0, checkout_error: 0, qty_price: 0, ghost_line: 0 },
      abandonment: { baseline: 0, dead_button: 0, cart_total: 0, checkout_error: 0, qty_price: 0, ghost_line: 0 },
      windowShoppers: 0,
      nearMiss: 0,
    },
    sessions,
  });
  const c = (id: string, sessions: string[], kind = 'element'): ClusterLike => ({ cluster_id: id, title: id, kind, anchor: 'a', route: '/', sessions, detectors: {} });

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

  it('treats a retro bug with no issue as silent, and holds it to the bar once an issue has it', () => {
    const withRetro = [...sessions, s(7, 'qty_price'), s(8, 'qty_price')];
    const silent = evaluate(truth(withRetro), [c('dead', ['s_1', 's_2']), c('total', ['s_3'])]);
    expect(silent.pass).toBe(true);
    expect(silent.bugs.find((b) => b.bug === 'qty_price')).toMatchObject({ silent: true, clusters: 0 });
    const found = evaluate(truth(withRetro), [c('dead', ['s_1', 's_2']), c('total', ['s_3']), c('cap', ['s_7'])]);
    expect(found.bugs.find((b) => b.bug === 'qty_price')).toMatchObject({ silent: false, recall: 0.5 });
    expect(found.failures.join('\n')).toMatch(/qty_price: recall 50.0%/);
  });

  it('scores the issue a merchant rule produced for a retro bug', () => {
    const t = truth([...sessions, s(7, 'qty_price'), s(8, 'qty_price')]);
    expect(evaluateRetro(t, 'qty_price', ['s_7', 's_8', 'old_run'])).toEqual({ bug: 'qty_price', affected: 2, recall: 1, precision: 1, others: 0 });
    expect(evaluateRetro(t, 'qty_price', ['s_7', 's_4'])).toMatchObject({ recall: 0.5, precision: 0.5, others: 1 });
  });

  describe('a bug the agent suggests a rule for (SUGGESTED_RULE_BUGS)', () => {
    const withGhost = [...sessions, s(9, 'ghost_line'), s(10, 'ghost_line')];
    const base = [c('dead', ['s_1', 's_2']), c('total', ['s_3'])];

    it('is ghost_line', () => expect(SUGGESTED_RULE_BUGS).toEqual(['ghost_line']));

    it('is held to the bar on its element issue before any rule exists', () => {
      const r = evaluate(truth(withGhost), [...base, c('remove', ['s_9', 's_10'])]);
      expect(r.pass).toBe(true);
      expect(r.bugs.find((b) => b.bug === 'ghost_line')).toMatchObject({ clusters: 1, cluster_id: 'remove', recall: 1, precision: 1, rule_cluster_ids: [] });
    });

    it("allows the approved rule's invariant issue next to it: not a second issue, not unexpected", () => {
      const r = evaluate(truth(withGhost), [...base, c('remove', ['s_9', 's_10']), c('agent_rule', ['s_9', 's_10', 'old_run'], 'invariant')]);
      expect(r.failures).toEqual([]);
      expect(r.bugs.find((b) => b.bug === 'ghost_line')).toMatchObject({ clusters: 1, cluster_id: 'remove', recall: 1, precision: 1, rule_cluster_ids: ['agent_rule'] });
      expect(r.unexpected_clusters).toEqual([]);
    });

    it('still fails a missing or leaky element issue, and clean sessions in the rule issue', () => {
      const onlyRule = evaluate(truth(withGhost), [...base, c('agent_rule', ['s_9', 's_10'], 'invariant')]);
      expect(onlyRule.failures.join('\n')).toMatch(/ghost_line: expected 1 issue, found 0/);
      // Judged on the element issue even when the rule's issue holds more of its sessions.
      const low = evaluate(truth(withGhost), [...base, c('remove', ['s_9']), c('agent_rule', ['s_9', 's_10'], 'invariant')]);
      expect(low.bugs.find((b) => b.bug === 'ghost_line')).toMatchObject({ cluster_id: 'remove', recall: 0.5, rule_cluster_ids: ['agent_rule'] });
      expect(low.failures.join('\n')).toMatch(/ghost_line: recall 50.0%/);
      const leaky = evaluate(truth(withGhost), [...base, c('remove', ['s_9', 's_10']), c('agent_rule', ['s_9', 's_10', 's_5'], 'invariant')]);
      expect(leaky.clean_in_clusters).toEqual(['s_5']);
      expect(leaky.pass).toBe(false);
    });

    it('gives other bugs no such allowance', () => {
      const r = evaluate(truth(withGhost), [...base, c('remove', ['s_9', 's_10']), c('some_rule', ['s_1'], 'invariant')]);
      expect(r.failures.join('\n')).toMatch(/dead_button: expected 1 issue, found 2/);
      expect(r.bugs.find((b) => b.bug === 'dead_button')?.rule_cluster_ids).toEqual([]);
    });

    it("keeps the merchant's qty_price rule issue at 100% precision when it holds no ghost sessions", () => {
      const withRetro = [...withGhost, s(7, 'qty_price'), s(8, 'qty_price')];
      const r = evaluate(truth(withRetro), [
        ...base,
        c('remove', ['s_9', 's_10']),
        c('agent_rule', ['s_9', 's_10'], 'invariant'),
        c('merchant_cap', ['s_7', 's_8', 'old_run'], 'invariant'),
      ]);
      expect(r.failures).toEqual([]);
      expect(r.bugs.find((b) => b.bug === 'qty_price')).toMatchObject({ cluster_id: 'merchant_cap', clusters: 1, recall: 1, precision: 1, silent: false, rule_cluster_ids: [] });
      expect(r.bugs.find((b) => b.bug === 'ghost_line')).toMatchObject({ cluster_id: 'remove', precision: 1, rule_cluster_ids: ['agent_rule'] });
      expect(evaluateRetro(truth(withRetro), 'qty_price', ['s_7', 's_8'])).toMatchObject({ recall: 1, precision: 1, others: 0 });
    });

    it("fails when the agent rule's issue also holds another bug's sessions", () => {
      const withRetro = [...withGhost, s(7, 'qty_price')];
      const r = evaluate(truth(withRetro), [...base, c('remove', ['s_9', 's_10']), c('agent_rule', ['s_9', 's_10', 's_7'], 'invariant')]);
      expect(r.failures.join('\n')).toMatch(/qty_price: precision 33.3%/);
      // Not a pure rule issue any more, so it no longer gets the allowance: it is ghost_line's second issue.
      expect(r.failures.join('\n')).toMatch(/ghost_line: expected 1 issue, found 2/);
      expect(r.bugs.find((b) => b.bug === 'ghost_line')?.rule_cluster_ids).toEqual([]);
    });
  });

  it('leaves failed browser runs out of scoring', () => {
    const r = evaluate(truth([...sessions, s(6, 'cart_total', { error: 'timed out' })]), [c('dead', ['s_1', 's_2']), c('total', ['s_3'])]);
    expect(r).toMatchObject({ pass: true, scored_sessions: 5, failed_sessions: 1 });
  });
});

describe('Phase 3 exit test (findings)', async () => {
  const { evaluateFindings } = await import('../src/truth.js');
  const bug = (b: Bug, cluster_id: string | null) => ({ bug: b, affected: 3, clusters: 1, cluster_id, title: 't', recall: 1, precision: 1, silent: false, rule_cluster_ids: [] });
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
