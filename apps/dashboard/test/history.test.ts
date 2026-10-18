import { describe, expect, it } from 'vitest';
import type { HistoryFindingView } from '../src/api';
import { parseRoute } from '../src/lib/route';
import { defaultAsOf, totalAtRisk } from '../src/lib/history';

const f = (over: Partial<HistoryFindingView>): HistoryFindingView => ({
  finding_id: 'a',
  version: 1,
  title: 't',
  tier: 'P1',
  score: 1,
  status: 'open',
  revenue_at_risk_minor: 100,
  currency: 'INR',
  revenue_status: 'ok',
  affected_sessions: 1,
  kind: 'invariant',
  route: '/cart',
  valid_from: 0,
  recorded_from: 0,
  recorded_to: null,
  found_later_sessions: 0,
  model_version: null,
  ...over,
});

describe('time travel helpers', () => {
  it('adds up revenue at risk only where it was estimated, in one currency', () => {
    expect(totalAtRisk([f({ revenue_at_risk_minor: 100 }), f({ revenue_at_risk_minor: 50 }), f({ revenue_status: 'insufficient_data', revenue_at_risk_minor: 999 })])).toEqual({ minor: 150, currency: 'INR' });
    expect(totalAtRisk([])).toEqual({ minor: 0, currency: null });
  });

  it('starts just before the latest rule approval, else now', () => {
    expect(defaultAsOf([], 5_000)).toBe(5_000);
    expect(
      defaultAsOf(
        [
          { at: 2_000, kind: 'rule_approved', rule_id: 'a', label: '' },
          { at: 3_000, kind: 'rescan_done', rule_id: 'a', label: '' },
        ],
        5_000,
      ),
    ).toBe(1_000);
  });

  it('routes to the rules and time travel pages', () => {
    expect(parseRoute('#/rules')).toEqual({ page: 'rules' });
    expect(parseRoute('#/rules/live')).toEqual({ page: 'rules', tab: 'live' });
    expect(parseRoute('#/rules/probes')).toEqual({ page: 'rules', tab: 'probes' });
    expect(parseRoute('#/rules/other')).toEqual({ page: 'dashboard' });
    expect(parseRoute('#/history')).toEqual({ page: 'history' });
  });
});
