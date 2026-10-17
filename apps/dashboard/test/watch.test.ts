import { describe, expect, it } from 'vitest';
import type { WatchMeta } from '@cp/schema';
import type { RuleView } from '../src/api';
import { openProposals, toastLine } from '../src/lib/inbox';
import { probeValue } from '../src/lib/probes';
import { liveOrigin } from '../src/lib/rules';
import { chanceText, watchSummary, watchValue } from '../src/lib/watch';

/** Dashboard helpers for the churn watcher and probes. All data is synthetic. */

const watch: WatchMeta = {
  feature: { key: 'dom:/checkout|span#delivery-fee', name: 'delivery_fee', source: 'discovered', selector: 'span#delivery-fee', route: '/checkout', unit: 'money' },
  direction: 'gte',
  threshold: 49_900,
  segment: { sessions: 12, abandoned: 10, abandonment: 10 / 12 },
  baseline: { sessions: 90, abandoned: 22, abandonment: 22 / 90 },
  lift: 10 / 12 - 22 / 90,
  p_value: 0.00002,
  values: { segment_min: 49_900, segment_max: 49_900, others_max: null, others_median: null },
  session_ids: [],
  churn_reason: 'shipping_cost',
  title: 'Unexpected ₹499 delivery fee at checkout',
  hypothesis: 'They leave.',
  confidence: 'high',
  found_at: 1,
};

const view = (rule_id: string, created_at: number, w?: WatchMeta, origin: 'agent' | 'human' = 'agent') =>
  ({ rule_id, draft: { origin, created_at, rule: { title: `Rule ${rule_id}` }, ...(w ? { watch: w } : {}) } }) as unknown as RuleView;

describe('the agent inbox', () => {
  it('lists open agent proposals, newest first, and leaves out merchant drafts and live rules', () => {
    const list = openProposals([view('a', 1, watch), view('b', 3), view('c', 2, undefined, 'human'), { rule_id: 'd', draft: null } as unknown as RuleView]);
    expect(list.map((r) => r.rule_id)).toEqual(['b', 'a']);
  });

  it('says what the agent suspects, with the gap, or that it suggests a rule', () => {
    expect(toastLine(view('a', 1, watch))).toEqual({ title: 'Unexpected ₹499 delivery fee at checkout', detail: '83% of 12 shoppers left, against 24% of the others.' });
    expect(toastLine(view('b', 1))).toEqual({ title: 'Rule b', detail: 'A rule suggested for a recurring issue.' });
  });
});

describe('hypothesis cards', () => {
  it('says how unlikely chance is, plainly', () => {
    expect(chanceText(0.00002)).toBe('very unlikely to be chance (p < 0.001)');
    expect(chanceText(0.004)).toBe('unlikely to be chance (p = 0.004)');
    expect(chanceText(0.2)).toBe('p = 0.20');
  });

  it('shows a value in its unit', () => {
    expect(watchValue('money', 49_900)).toBe('₹499');
    expect(watchValue('ms', 6500)).toBe('6.5 s');
    expect(watchValue('ms', 240)).toBe('240 ms');
    expect(watchValue('count', 9)).toBe('9');
    expect(watchValue('count', null)).toBe('none');
  });

  it('sums up a watch pass', () => {
    expect(watchSummary({ results: { sessions: 240, decided: 160, numbers: 41, candidates: [{ outcome: 'drafted' }, { outcome: 'declined' }] } })).toBe(
      'Looked at 240 sessions (160 with a settled cart) and 41 numbers: 1 new hypothesis, 1 judged not worth a rule.',
    );
    expect(watchSummary({ results: { sessions: 3, decided: 0, numbers: 2, candidates: [] } })).toBe('Looked at 3 sessions (0 with a settled cart) and 2 numbers: nothing new.');
  });
});

describe('probes', () => {
  it('formats probe values by name and kind', () => {
    expect(probeValue('req_post_api_payment_authorize_ms', 6517)).toBe('6.5 s');
    expect(probeValue('req_get_api_stock_ms', 153)).toBe('153 ms');
    expect(probeValue('req_post_api_checkout_status', 500)).toBe('500');
    expect(probeValue('cart_total', 699_500)).toBe('₹6,995');
    expect(probeValue('qty', 2)).toBe('2');
    expect(probeValue('delivery_days', 9, 'count')).toBe('9');
  });
});

describe('who a live rule came from', () => {
  const live = (extra: Partial<RuleView>): RuleView => ({ rule_id: 'r', title: 't', active: { approved_at: 1, approved_by: 'x' }, ...extra }) as unknown as RuleView;

  it('reads the recorded origin, else falls back to the approval feedback', () => {
    expect(liveOrigin(live({ active: { origin: 'agent' } as never }))).toBe('agent');
    expect(liveOrigin(live({ feedback: [{ verdict: 'approved', feature_key: 'probe:delivery_fee:gte' }] as never }))).toBe('agent');
    expect(liveOrigin(live({ feedback: [{ verdict: 'approved', feature_key: null }] as never }))).toBe('human');
    expect(liveOrigin(live({}))).toBe('human');
  });
});
