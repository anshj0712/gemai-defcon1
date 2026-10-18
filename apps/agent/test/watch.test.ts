import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalBlobStore, LocalStateStore, LocalWarehouse, LocalWarehouseReader, type Publisher } from '@cp/platform';
import type { ChurnAnalystOutput, ProbeEvent, WatchFeature } from '@cp/schema';
import { SessionScript } from '@cp/testkit';
import { validateChurnAnalyst } from '../src/agents/churn-analyst.js';
import { OfflineLlm } from '../src/llm/offline.js';
import { offlineChurnAnalyst } from '../src/llm/offline-watch.js';
import { createRuleService } from '../src/rules/service.js';
import { bestSegment, decidedSessions, DEFAULT_WATCH_PARAMS, findSegments, suggestedLimit, upperTail, type Decided, type Segment } from '../src/watch/contrast.js';
import { nameForSelector, sessionNumbers } from '../src/watch/features.js';
import { createChurnWatcher } from '../src/watch/watcher.js';
import { tenantContext } from '../src/pipeline.js';
import { outcome, quiet, seedCartOutcome, seedScript, T } from './helpers.js';

/** The churn watcher: statistics, the numbers it reads, the analyst's checks, and a whole pass. All synthetic. */

const feature = (over: Partial<WatchFeature> = {}): WatchFeature => ({ key: 'probe:req_post_api_payment_authorize_ms', name: 'req_post_api_payment_authorize_ms', source: 'request', selector: null, route: '/checkout', unit: 'ms', ...over });

/** `n` decided sessions with value `v`, `left` of them abandoned. */
function group(prefix: string, n: number, v: number, left: number, values: Map<string, number>, decided: Map<string, Decided>) {
  for (let i = 0; i < n; i++) {
    const id = `${prefix}_${i}`;
    values.set(id, v);
    decided.set(id, { abandoned: i < left, cartValueMinor: 1_000_000 });
  }
}

describe('contrast: segments of shoppers who leave more often', () => {
  it('computes the normal upper tail', () => {
    expect(upperTail(0)).toBeCloseTo(0.5, 6);
    expect(upperTail(1.959964)).toBeCloseTo(0.025, 4);
    expect(upperTail(-1.959964)).toBeCloseTo(0.975, 4);
  });

  it('finds the threshold where abandonment jumps, against everyone else', () => {
    const values = new Map<string, number>();
    const decided = new Map<string, Decided>();
    group('slow', 10, 6500, 8, values, decided);
    group('fast', 40, 300, 10, values, decided);
    const seg = bestSegment(feature(), values, decided, new Set(), DEFAULT_WATCH_PARAMS)!;
    expect(seg).toMatchObject({ direction: 'gte', threshold: 6500, segment: { sessions: 10, abandoned: 8 }, baseline: { sessions: 40, abandoned: 10 }, values: { segment_min: 6500, others_max: 300 } });
    expect(seg.lift).toBeCloseTo(0.55, 6);
    expect(seg.p).toBeLessThan(0.001);
    expect(suggestedLimit(seg)).toBe(3400);
  });

  it('wants a step, not a slope: a segment whose values do not stand apart is no candidate', () => {
    // Bigger carts abandon more, smoothly: 20 at ₹10,000-₹19,500 (4 leave) and 20 at ₹20,000-₹29,500 (16 leave).
    const values = new Map<string, number>();
    const decided = new Map<string, Decided>();
    for (let i = 0; i < 20; i++) {
      values.set(`low_${i}`, 1_000_000 + i * 50_000);
      decided.set(`low_${i}`, { abandoned: i < 4, cartValueMinor: 1 });
      values.set(`high_${i}`, 2_000_000 + i * 50_000);
      decided.set(`high_${i}`, { abandoned: i < 16, cartValueMinor: 1 });
    }
    expect(bestSegment(feature({ unit: 'money' }), values, decided, new Set(), DEFAULT_WATCH_PARAMS)).toBeNull();
    // The same gap as a step (a ₹499 fee against none) is one.
    expect(bestSegment(feature({ unit: 'money' }), values, decided, new Set(), { ...DEFAULT_WATCH_PARAMS, minSeparation: 1 })).not.toBeNull();
  });

  it('counts the segment shoppers whose cart has not settled, so the watcher can wait for them', () => {
    const values = new Map<string, number>();
    const decided = new Map<string, Decided>();
    group('slow', 10, 6500, 8, values, decided);
    group('fast', 40, 300, 10, values, decided);
    values.set('slow_late_1', 6500);
    values.set('slow_late_2', 6500);
    const seg = bestSegment(feature(), values, decided, new Set(), DEFAULT_WATCH_PARAMS, new Set(), new Set(['slow_late_1', 'slow_late_2', 'fast_x']))!;
    expect(seg.pending).toBe(2);
  });

  it('finds nothing when abandonment does not depend on the number', () => {
    const values = new Map<string, number>();
    const decided = new Map<string, Decided>();
    group('a', 20, 300, 5, values, decided);
    group('b', 20, 6500, 5, values, decided);
    expect(bestSegment(feature(), values, decided, new Set(), DEFAULT_WATCH_PARAMS)).toBeNull();
  });

  it('skips segments detection already explains, and merges the same shoppers under the existing probe', () => {
    const values = new Map<string, number>();
    const decided = new Map<string, Decided>();
    group('slow', 10, 6500, 8, values, decided);
    group('fast', 40, 300, 10, values, decided);
    const dom = feature({ key: 'dom:/checkout|span.wait', name: 'wait', source: 'discovered', selector: 'span.wait', unit: 'count' });
    const numbers = new Map([
      ['probe:req', { feature: feature(), values }],
      ['dom:wait', { feature: dom, values }],
    ]);
    expect(findSegments(numbers, decided, new Set(), DEFAULT_WATCH_PARAMS).map((s) => s.feature.source)).toEqual(['request']);
    const inIssues = new Set([...values.keys()].filter((k) => k.startsWith('slow')));
    expect(findSegments(numbers, decided, inIssues, DEFAULT_WATCH_PARAMS)).toEqual([]);
  });

  it('keeps silent problems from hiding each other: each is judged against shoppers no other one explains', () => {
    // 12 clean shoppers (3 leave), and two silent problems of 12 shoppers each (9 leave). Against everyone else,
    // each problem's baseline holds the other problem's shoppers (12/24 leave) and the gap looks small.
    const decided = new Map<string, Decided>();
    const slow = new Map<string, number>();
    const fee = new Map<string, number>();
    group('clean', 12, 300, 3, slow, decided);
    for (let i = 0; i < 12; i++) fee.set(`clean_${i}`, 0);
    group('slowbank', 12, 6500, 9, slow, decided);
    for (let i = 0; i < 12; i++) fee.set(`slowbank_${i}`, 0);
    const feeDecided = new Map<string, Decided>();
    group('fee', 12, 49_900, 9, fee, feeDecided);
    for (const [id, d] of feeDecided) decided.set(id, d);
    for (let i = 0; i < 12; i++) slow.set(`fee_${i}`, 300);
    const params = { ...DEFAULT_WATCH_PARAMS, minLift: 0.35 };
    const numbers = new Map([
      ['probe:slow', { feature: feature(), values: slow }],
      ['dom:fee', { feature: feature({ key: 'dom:fee', name: 'delivery_fee', source: 'discovered', unit: 'money' }), values: fee }],
    ]);
    // One pass against everyone: 75% against 50% is a 25-point gap, under the bar.
    expect(bestSegment(feature(), slow, decided, new Set(), params)).toBeNull();
    // Explaining each other away, both clear it: 75% against the clean 25%.
    const found = findSegments(numbers, decided, new Set(), params);
    expect(found.map((s) => [s.feature.key, s.segment.sessions, s.baseline.sessions, Math.round(s.lift * 100)])).toEqual([
      ['probe:req_post_api_payment_authorize_ms', 12, 12, 50],
      ['dom:fee', 12, 12, 50],
    ]);
  });

  it('suggests a limit between everyone else and the segment, or 0 when only the segment shows the number', () => {
    const seg = (unit: WatchFeature['unit'], threshold: number, others_max: number | null): Pick<Segment, 'direction' | 'threshold' | 'values' | 'feature'> => ({
      direction: 'gte',
      threshold,
      feature: feature({ unit }),
      values: { segment_min: threshold, segment_max: threshold, others_max, others_median: others_max },
    });
    expect(suggestedLimit(seg('money', 49_900, null))).toBe(0);
    expect(suggestedLimit(seg('count', 9, 2))).toBe(5);
    expect(suggestedLimit(seg('ms', 4022, 180))).toBe(2100);
    expect(suggestedLimit(seg('money', 13_990_000, 3_399_000))).toBe(8_694_500);
  });

  it('decides a session once it has a cart and has gone quiet', () => {
    const d = decidedSessions([outcome('s1', { last_seen: T }), outcome('s2', { last_seen: T + 100_000 }), outcome('s3', { cart_value_minor: null })], T + 150_000, 120_000);
    expect([...d.keys()]).toEqual(['s1']);
  });
});

describe('the numbers a session reports', () => {
  it('names a page element from its selector', () => {
    expect(nameForSelector('span#delivery-fee')).toBe('delivery_fee');
    expect(nameForSelector('#checkout > span')).toBe('span');
    expect(nameForSelector('p.eta.small')).toBe('eta_small');
    expect(nameForSelector('div[data-testid="eta-days"]')).toBe('eta_days');
    expect(nameForSelector('p.9x')).toBe('el_9x');
  });

  it('keeps each probe and each unprobed number at its largest value, leaving out declared and registered elements', () => {
    const probe = (values: Record<string, number[]>, source?: ProbeEvent['source']): ProbeEvent => ({ kind: 'probe', t: 1, seq: 0, values, currency: 'INR', route: '/checkout', ...(source ? { source } : {}) });
    const n = sessionNumbers(
      {
        session_id: 's',
        chunks: [{ seq: 0, pageRoute: '/checkout', release: 'r', tStart: 0, tEnd: 1, probes: [probe({ cart_total: [699_500] }), probe({ req_post_api_pay_ms: [250], req_post_api_pay_status: [200] }, 'request'), probe({ req_post_api_pay_ms: [6500] }, 'request')] }],
        discovered: [
          { t: 1, route: '/checkout', candidates: [{ selector: 'span#delivery-fee', kind: 'money', values: [49_900] }, { selector: 'span[data-cp-probe="cart_total"]', kind: 'money', values: [699_500] }, { selector: 'p.eta', kind: 'count', values: [9] }] },
          { t: 2, route: '/order/:id', candidates: [{ selector: 'p.order', kind: 'count', values: [123456] }] },
        ],
      },
      [{ name: 'eta_days', selector: 'p.eta', routes: ['/checkout'], kind: 'count' }],
    );
    expect(Object.fromEntries(n.values)).toEqual({ 'probe:cart_total': 699_500, 'probe:req_post_api_pay_ms': 6500, 'probe:req_post_api_pay_status': 200, 'dom:/checkout|span#delivery-fee': 49_900 });
    expect(n.features.get('probe:req_post_api_pay_ms')).toMatchObject({ source: 'request', unit: 'ms' });
    expect(n.features.get('probe:cart_total')).toMatchObject({ source: 'declared', unit: 'money' });
    expect(n.features.get('dom:/checkout|span#delivery-fee')).toMatchObject({ source: 'discovered', name: 'delivery_fee', selector: 'span#delivery-fee', unit: 'money' });
  });
});

describe('the churn analyst', () => {
  const segment = (over: Partial<WatchFeature> = {}) => ({ feature: feature(over) }) as Segment;
  const ok: ChurnAnalystOutput = {
    propose: true,
    churn_reason: 'payment_gateway',
    title: 'Payment authorisation takes 6.5 s or more',
    hypothesis: { text: 'They leave.', evidence_ids: ['H1'] },
    probe_name: '',
    sentence: 'req_post_api_payment_authorize_ms must never be more than 3400 ms.',
    confidence: 'high',
    assumptions: [],
  };
  const supplied = new Set(['H1', 'P1', 'F1']);

  it('accepts a grounded proposal and rejects unknown ids, an uncited candidate, and a sentence that does not name the probe', () => {
    expect(validateChurnAnalyst(ok, { supplied, segment: segment(), takenNames: new Set() })).toEqual([]);
    expect(validateChurnAnalyst({ ...ok, hypothesis: { text: 'x', evidence_ids: ['H1', 'E9'] } }, { supplied, segment: segment(), takenNames: new Set() }).join()).toMatch(/E9/);
    expect(validateChurnAnalyst({ ...ok, hypothesis: { text: 'x', evidence_ids: ['P1'] } }, { supplied, segment: segment(), takenNames: new Set() }).join()).toMatch(/H1/);
    expect(validateChurnAnalyst({ ...ok, sentence: 'Payments must be fast, always.' }, { supplied, segment: segment(), takenNames: new Set() }).join()).toMatch(/name the probe/);
  });

  it('needs a free snake_case name for a discovered number, and nothing when it declines', () => {
    const dom = segment({ source: 'discovered', name: 'delivery_fee', selector: 'span#delivery-fee', unit: 'money' });
    const fee = { ...ok, probe_name: 'delivery_fee', sentence: 'The delivery_fee must never be more than ₹0.' };
    expect(validateChurnAnalyst(fee, { supplied, segment: dom, takenNames: new Set() })).toEqual([]);
    expect(validateChurnAnalyst({ ...fee, probe_name: 'Delivery Fee' }, { supplied, segment: dom, takenNames: new Set() }).join()).toMatch(/snake_case/);
    expect(validateChurnAnalyst(fee, { supplied, segment: dom, takenNames: new Set(['delivery_fee']) }).join()).toMatch(/already a probe/);
    expect(validateChurnAnalyst({ ...fee, probe_name: 'req_fee' }, { supplied, segment: dom, takenNames: new Set() }).join()).toMatch(/reserved/);
    expect(validateChurnAnalyst({ ...ok, propose: false, sentence: 'x' }, { supplied, segment: segment(), takenNames: new Set() }).join()).toMatch(/empty/);
  });

  it('offline: proposes a fee rule for a delivery fee, a speed rule for a slow call, and declines a shoe size', () => {
    const candidate = (number: object, threshold: number, limit: number) => ({
      evidence: [{ id: 'H1', kind: 'candidate', number, direction: 'at or above the threshold', threshold, suggested_limit: limit, segment: { sessions: 12, abandonment: 0.83 }, others: { sessions: 120, abandonment: 0.24 } }],
    });
    expect(offlineChurnAnalyst(candidate({ name: 'delivery_fee', source: 'discovered', selector: 'span#delivery-fee', page: '/checkout', unit: 'money' }, 49_900, 0))).toMatchObject({
      propose: true,
      churn_reason: 'shipping_cost',
      title: 'Unexpected ₹499 delivery fee at checkout',
      probe_name: 'delivery_fee',
      sentence: 'The delivery_fee must never be more than ₹0.',
      confidence: 'high',
    });
    expect(offlineChurnAnalyst(candidate({ name: 'req_post_api_payment_authorize_ms', source: 'request', page: '/checkout', unit: 'ms' }, 6500, 3400))).toMatchObject({
      churn_reason: 'payment_gateway',
      probe_name: '',
      sentence: 'The req_post_api_payment_authorize_ms must never be more than 3400 ms.',
    });
    expect(offlineChurnAnalyst(candidate({ name: 'eta', source: 'discovered', selector: 'p.eta', page: '/product/:id', unit: 'count' }, 9, 5))).toMatchObject({ churn_reason: 'delivery_time', sentence: 'The eta must never be more than 5.' });
    expect(offlineChurnAnalyst(candidate({ name: 'muted', source: 'discovered', selector: 'p.muted', page: '/cart', unit: 'count' }, 11, 9))).toMatchObject({ propose: false, sentence: '' });
  });
});

describe('a churn watch pass', () => {
  const NodeType = { Document: 0, Element: 2, Text: 3 } as const;
  const el = (id: number, tagName: string, attributes: Record<string, string> = {}, childNodes: unknown[] = []) => ({ type: NodeType.Element, id, tagName, attributes, childNodes });
  const text = (id: number, textContent: string) => ({ type: NodeType.Text, id, textContent });
  const checkout = (start: number, fee: string, bankMs: number) =>
    new SessionScript(start)
      .meta(0, 'http://localhost:5173/checkout')
      .snapshot(5, { type: NodeType.Document, id: 1, childNodes: [el(2, 'html', {}, [el(3, 'body', {}, [el(4, 'main', { id: 'checkout' }, [el(5, 'span', { id: 'delivery-fee' }, [text(6, fee)])])])])] })
      .net(1000, { phase: 'start', method: 'POST', route: '/api/payment/authorize' })
      .net(1000 + bankMs, { phase: 'end', method: 'POST', route: '/api/payment/authorize', status: 200, duration_ms: bankMs });
  const NOOP: Publisher = { publish: async () => '1', close: async () => {} };

  let blob: LocalBlobStore;
  let warehouse: LocalWarehouse;
  let state: LocalStateStore;
  const clock = T + 3_600_000;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-watch-'));
    blob = new LocalBlobStore(join(dir, 'gcs'), 'raw');
    warehouse = new LocalWarehouse(join(dir, 'bq'));
    state = new LocalStateStore(join(dir, 'firestore'));
    // 10 shoppers meet a ₹499 delivery fee (9 leave); 10 wait 6.5 s for the bank (9 leave); 40 see neither (8 leave).
    let n = 0;
    const add = async (prefix: string, count: number, left: number, fee: string, bankMs: number) => {
      for (let i = 0; i < count; i++, n++) {
        const id = `s_${prefix}_${String(i).padStart(10, '0')}`;
        await seedScript({ blob, warehouse }, id, checkout(T + n * 10_000, fee, bankMs), '/checkout');
        await seedCartOutcome(warehouse, id, T + n * 10_000 + 2000, 1_299_500, i >= left);
      }
    };
    await add('fee', 10, 9, '₹499', 250);
    await add('bank', 10, 9, 'Free', 6500);
    await add('ok', 40, 8, 'Free', 300);
  });

  const services = () => {
    const rules = createRuleService({
      state,
      warehouse,
      reader: new LocalWarehouseReader(warehouse),
      blob,
      publisher: NOOP,
      signalsTopic: 'signals',
      models: { bulk: new OfflineLlm(), reasoning: new OfflineLlm(), offline: true },
      logger: quiet,
      tenants: ['demo'],
      dryRun: { sessions: 200, days: 30 },
      rescan: { sessions: 200, days: 30, concurrency: 4 },
      revenue: { abandonAfterIdleMs: 120_000, minBaselineSessions: 5, minAffectedDecided: 3 },
      runOptions: { sleep: async () => {}, backoffMs: 1 },
      now: () => clock,
    });
    const watcher = createChurnWatcher({
      state,
      reader: new LocalWarehouseReader(warehouse),
      blob,
      models: { bulk: new OfflineLlm(), reasoning: new OfflineLlm(), offline: true },
      logger: quiet,
      tenants: ['demo'],
      rules,
      params: DEFAULT_WATCH_PARAMS,
      windowDays: 7,
      maxSessions: 500,
      concurrency: 4,
      revenue: { abandonAfterIdleMs: 120_000, minBaselineSessions: 5, minAffectedDecided: 3 },
      runOptions: { sleep: async () => {}, backoffMs: 1 },
      now: () => clock,
    });
    return { rules, watcher };
  };

  it('drafts a probe and rule for each segment, with the hypothesis, and nothing runs until approval', async () => {
    const { rules, watcher } = services();
    const result = await watcher.run('demo');
    expect(result).toMatchObject({ sessions: 60, sessions_read: 60, decided: 60 });
    expect(result.candidates.map((c) => [c.outcome, c.sessions])).toEqual([
      ['drafted', 10],
      ['drafted', 10],
    ]);
    const docs = await state.listRules('demo');
    const fee = docs.find((d) => d.draft?.watch?.feature.source === 'discovered')!;
    const bank = docs.find((d) => d.draft?.watch?.feature.source === 'request')!;
    expect(fee.draft).toMatchObject({
      origin: 'agent',
      cluster_id: null,
      proposed_probes: [{ name: 'delivery_fee', selector: 'span#delivery-fee', routes: ['/checkout'], kind: 'money' }],
      watch: { churn_reason: 'shipping_cost', direction: 'gte', threshold: 49_900, segment: { sessions: 10, abandoned: 9 }, title: 'Unexpected ₹499 delivery fee at checkout' },
      dry_run: { sessions_hit: 10 },
    });
    expect(fee.draft!.watch!.session_ids).toHaveLength(10);
    expect(bank.draft).toMatchObject({ watch: { churn_reason: 'payment_gateway', feature: { name: 'req_post_api_payment_authorize_ms' } }, dry_run: { sessions_hit: 10 } });
    expect(bank.draft!.proposed_probes).toBeUndefined();
    // A hypothesis is not a finding: no signal, no probe registered.
    expect(await warehouse.rows('signals')).toEqual([]);
    expect(await state.listProbes('demo')).toEqual([]);

    // Pending hypotheses are not proposed twice.
    expect((await watcher.run('demo')).candidates).toEqual([]);

    // Approving registers the proposed probe, and the re-scan flags exactly the shoppers who met the fee.
    await rules.approve('demo', fee.rule_id, fee.draft!.rule.version, 'merchant@test');
    await rules.idle();
    expect(await state.getProbe('demo', 'delivery_fee')).toMatchObject({ source: 'agent', status: 'active' });
    const signals = (await warehouse.rows('signals')) as unknown as { session_id: string }[];
    expect(new Set(signals.map((s) => s.session_id)).size).toBe(10);
    expect(signals.every((s) => s.session_id.startsWith('s_fee_'))).toBe(true);
    expect((await state.getRule('demo', fee.rule_id))!.feedback).toEqual([expect.objectContaining({ verdict: 'approved', feature_key: fee.draft!.watch!.feature.key, churn_reason: 'shipping_cost' })]);
    // The live rule remembers that the agent proposed it, so the dashboard can file it under the agent's rules.
    expect((await state.getRule('demo', fee.rule_id))!.active?.origin).toBe('agent');
  });

  it('publishes the shoppers it suspects, so revenue at risk leaves them out of its baseline', async () => {
    const { watcher } = services();
    expect(watcher.suspected('demo').size).toBe(0);
    await watcher.run('demo');
    const s = watcher.suspected('demo');
    expect([...s].filter((id) => id.startsWith('s_fee_')).length).toBe(10);
    expect([...s].filter((id) => id.startsWith('s_bank_')).length).toBe(10);
    expect([...s].some((id) => id.startsWith('s_ok_'))).toBe(false);
    // The pipeline's baseline: shoppers in an issue, and now shoppers some number may explain.
    const ctx = tenantContext([], [], s);
    expect(ctx.sessionsInAnyIssue.size).toBe(20);
  });

  it('remembers a rejection with its note, and does not raise the same number again', async () => {
    const { rules, watcher } = services();
    await watcher.run('demo');
    const bank = (await state.listRules('demo')).find((d) => d.draft?.watch?.feature.source === 'request')!;
    await rules.reject('demo', bank.rule_id, 'merchant@test', 'The bank is slow on purpose for fraud checks');
    const after = (await state.getRule('demo', bank.rule_id))!;
    expect(after.draft).toBeNull();
    expect(after.feedback).toEqual([expect.objectContaining({ verdict: 'rejected', note: 'The bank is slow on purpose for fraud checks', by: 'merchant@test', feature_key: 'probe:req_post_api_payment_authorize_ms' })]);
    const again = await watcher.run('demo');
    expect(again.candidates.map((c) => c.feature_key)).not.toContain('probe:req_post_api_payment_authorize_ms');
  });

  it('changes a hypothesis rule from an edited sentence, keeping its probe and hypothesis', async () => {
    const { rules, watcher } = services();
    await watcher.run('demo');
    const fee = (await state.listRules('demo')).find((d) => d.draft?.watch?.feature.source === 'discovered')!;
    const next = await rules.redraft('demo', fee.rule_id, 'The delivery_fee must never be more than ₹99.');
    expect(next.draft).toMatchObject({ origin: 'agent', proposed_probes: [{ name: 'delivery_fee' }], watch: { churn_reason: 'shipping_cost' }, rule: { assert: { right: { const: 9900 } } } });
    if (next.rule_id !== fee.rule_id) expect((await state.getRule('demo', fee.rule_id))!.draft).toBeNull();
  });
});
