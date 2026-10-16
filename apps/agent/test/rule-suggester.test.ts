import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkRule } from '@cp/detectors';
import { LocalBlobStore, LocalStateStore, LocalWarehouse, LocalWarehouseReader, type Publisher } from '@cp/platform';
import { RuleSuggesterOutput, ruleText, type Cluster, type RevenueAtRisk, type RuleAuthorMeta } from '@cp/schema';
import { RULE_SUGGESTER, ruleSuggesterInput, SUGGEST_PROMPT_VERSION } from '../src/agents/rule-suggester.js';
import { buildEvidence } from '../src/evidence.js';
import { validateRuleSuggestion } from '../src/grounding.js';
import type { ModelSet } from '../src/llm/models.js';
import { offlineRuleAuthor, PAIRS_PER_LINE_SENTENCE } from '../src/llm/offline-rules.js';
import { OfflineLlm } from '../src/llm/offline.js';
import { runStructured } from '../src/llm/run-agent.js';
import { llmKey, shouldSuggestRule, suggestionKey, toFindingRow, versionHash, type RuleSuggestDeps, type RuleSuggestParams } from '../src/pipeline.js';
import { RETRO_RULE_SENTENCE } from '../../../sim/src/plan.js';
import { compileRule } from '../src/rules/compile.js';
import type { ProbeCatalog } from '../src/rules/evaluate.js';
import { createRuleService, RuleError, type RuleService } from '../src/rules/service.js';
import { DEFAULT_PRIORITY_RULES, revenueAtRisk, type RevenueParams } from '../src/scoring/index.js';
import { createAgentService, type ServiceDeps } from '../src/service.js';
import { clusterOf, demoClusters, ghostLineCluster, quiet, RecordedLlm, seedCartOutcome, seedRawSession, signal, T } from './helpers.js';

/** All sessions, amounts, and ids are synthetic. */

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as RuleSuggesterOutput;
const noSleep = { sleep: async () => undefined, backoffMs: 1 };
const PARAMS: RuleSuggestParams = { enabled: true, minSessions: 10, minDays: 0, minDetectorShare: 0.5, maxSessions: 25 };
const REVENUE: RevenueParams = { abandonAfterIdleMs: 120_000, minBaselineSessions: 5, minAffectedDecided: 3 };
const EXAMPLES = [
  'No pair of shoes costs more than ₹17,000, so the bag subtotal must never be more than ₹17,000 times the number of pairs.',
  'The discount must never be more than 10% of the bag.',
  'The cart total must equal the line items minus the discount.',
];

const okRevenue = (over: Partial<RevenueAtRisk> = {}): RevenueAtRisk => ({
  revenue_at_risk_minor: 5_500_000,
  currency: 'INR',
  status: 'ok',
  note: null,
  affected_with_cart: 10,
  affected_decided: 10,
  affected_abandoned: 8,
  abandonment_affected: 0.8,
  baseline_decided: 12,
  baseline_abandoned: 3,
  abandonment_baseline: 0.25,
  baseline_scope: 'route',
  avg_cart_value_minor: 1_000_000,
  pending: 0,
  ...over,
});

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `s_${prefix}_${String(i).padStart(4, '0')}`);
const GHOST = ids('ghost', 10);
const CLEAN = ids('clean', 12);
const DEAD = ids('dead', 10);

const LINE = 699_500;
const clean = { line_total: [LINE], qty: [1], discount: [0], cart_total: [LINE] };
const clean2 = { line_total: [2 * LINE], qty: [2], discount: [0], cart_total: [2 * LINE] };
// ghost_line: Remove at quantity 1 leaves the line in the bag at quantity 0, shown at ₹0, next to a real
// line; totals agree, so no built-in rule fires (and the per-pair price cap does not either).
const ghost = (i: number) => {
  const p = i % 2 === 0 ? LINE : 499_500;
  return { line_total: [p, 0], qty: [1, 0], discount: [0], cart_total: [p] };
};

/** Probe statistics of the ghost_line sessions (P1 cart_total, P2 discount, P3 line_total, P4 qty). */
const ghostCatalog: ProbeCatalog = {
  probes: [
    { name: 'cart_total', source: 'declared', snapshots: 20, values_per_snapshot: { min: 1, max: 1 }, min: 499_500, median: LINE, max: LINE, routes: ['/cart'] },
    { name: 'discount', source: 'declared', snapshots: 20, values_per_snapshot: { min: 1, max: 1 }, min: 0, median: 0, max: 0, routes: ['/cart'] },
    { name: 'line_total', source: 'declared', snapshots: 20, values_per_snapshot: { min: 1, max: 2 }, min: 0, median: LINE, max: LINE, routes: ['/cart'] },
    { name: 'qty', source: 'declared', snapshots: 20, values_per_snapshot: { min: 1, max: 2 }, min: 0, median: 1, max: 1, routes: ['/cart'] },
  ],
  routes: ['/cart'],
  currencies: ['INR'],
  sessions: 10,
};
const cleanCatalog: ProbeCatalog = { ...ghostCatalog, probes: ghostCatalog.probes.map((p) => (p.name === 'qty' ? { ...p, min: 1, max: 2 } : p.name === 'line_total' ? { ...p, min: 499_500 } : p)) };
const emptyCatalog: ProbeCatalog = { probes: [], routes: [], currencies: [], sessions: 0 };

function suggesterTurn(cluster: Cluster, catalog: ProbeCatalog) {
  const evidence = buildEvidence({ cluster, signals: [], revenue: okRevenue(), regression: false });
  return { evidence, ...ruleSuggesterInput(evidence, { triage: null, revenue: okRevenue() }, catalog, []) };
}

// ---------------------------------------------------------------------------------------------

describe('shouldSuggestRule (the deterministic trigger)', () => {
  const cluster = ghostLineCluster(GHOST);
  const none = new Set<string>();

  it('trips on a recurring issue with one dominant symptom and a revenue estimate', () => {
    expect(cluster.detectors).toEqual({ dead_click: 10, rage_click: 4 });
    expect(shouldSuggestRule(cluster, okRevenue(), none, PARAMS)).toMatchObject({ ok: true });
  });

  it('holds each threshold', () => {
    expect(shouldSuggestRule(cluster, okRevenue(), none, { ...PARAMS, enabled: false }).ok).toBe(false);
    expect(shouldSuggestRule(cluster, okRevenue(), none, { ...PARAMS, minSessions: 11 })).toMatchObject({ ok: false, reason: expect.stringMatching(/fewer than 11/) });
    expect(shouldSuggestRule(cluster, okRevenue(), none, { ...PARAMS, minDays: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/days/) });
    expect(shouldSuggestRule({ ...cluster, last_seen: cluster.first_seen + 2 * 86_400_000 }, okRevenue(), none, { ...PARAMS, minDays: 1 }).ok).toBe(true);
    const mixed = { ...cluster, detectors: { dead_click: 4, rage_click: 4, response_decay: 4 }, signal_count: 12 };
    expect(shouldSuggestRule(mixed, okRevenue(), none, PARAMS)).toMatchObject({ ok: false, reason: expect.stringMatching(/33%/) });
    expect(shouldSuggestRule(mixed, okRevenue(), none, { ...PARAMS, minDetectorShare: 0.3 }).ok).toBe(true);
  });

  it('skips a data-rule issue an active rule already explains, but not an element issue', () => {
    const { total } = demoClusters(10);
    expect(total).toMatchObject({ kind: 'invariant', anchor: 'cart_total_matches_lines' });
    expect(shouldSuggestRule(total, okRevenue(), new Set(['cart_total_matches_lines']), PARAMS)).toMatchObject({ ok: false, reason: expect.stringMatching(/active rule/) });
    expect(shouldSuggestRule(total, okRevenue(), none, PARAMS).ok).toBe(true);
    expect(shouldSuggestRule(cluster, okRevenue(), new Set([cluster.anchor]), PARAMS).ok).toBe(true);
  });

  it('waits for a revenue estimate', () => {
    expect(shouldSuggestRule(cluster, okRevenue({ status: 'insufficient_data', revenue_at_risk_minor: 0 }), none, PARAMS)).toMatchObject({ ok: false, reason: expect.stringMatching(/revenue/) });
  });
});

describe('validateRuleSuggestion (grounding)', () => {
  const supplied = new Set(['E1', 'E2', 'P1', 'P2', 'R1']);
  const probes = new Set(['P1', 'P2']);
  const propose = (o: Partial<RuleSuggesterOutput> = {}): RuleSuggesterOutput => ({
    propose: true,
    sentence: PAIRS_PER_LINE_SENTENCE,
    assumptions: [],
    explanation: { text: 'qty reaches 0 and the line stays in the bag.', evidence_ids: ['E1', 'P2'] },
    ...o,
  });

  it('accepts a grounded proposal and a grounded decline', () => {
    expect(validateRuleSuggestion(propose(), supplied, probes)).toEqual([]);
    expect(validateRuleSuggestion(propose({ propose: false, sentence: '' }), supplied, probes)).toEqual([]);
  });

  it('rejects unknown ids, a missing or short sentence, a decline with a sentence, and a proposal without probe evidence', () => {
    expect(validateRuleSuggestion(propose({ explanation: { text: 'x', evidence_ids: ['E1', 'P9'] } }), supplied, probes)[0]).toMatch(/not supplied: P9/);
    expect(validateRuleSuggestion(propose({ sentence: '' }), supplied, probes)[0]).toMatch(/8 to 500 characters/);
    expect(validateRuleSuggestion(propose({ sentence: '  qty>0  ' }), supplied, probes)[0]).toMatch(/8 to 500 characters/);
    expect(validateRuleSuggestion(propose({ propose: false }), supplied, probes)).toEqual(['sentence must be an empty string when propose is false']);
    expect(validateRuleSuggestion(propose({ explanation: { text: 'x', evidence_ids: ['E1', 'R1'] } }), supplied, probes)[0]).toMatch(/must cite the probe statistics/);
    expect(validateRuleSuggestion(propose({ explanation: { text: 'x', evidence_ids: ['E1'] } }), new Set(['E1']), new Set())[0]).toMatch(/no probe statistics were supplied/);
  });

  it('accepts the recorded decline for the dead coupon button (fixture)', () => {
    const out = fixture('rule-suggester.dead-button');
    expect(RuleSuggesterOutput.safeParse(out).success).toBe(true);
    const { evidenceIds, probeIds } = suggesterTurn(demoClusters(10).dead, cleanCatalog);
    expect(validateRuleSuggestion(out, evidenceIds, probeIds)).toEqual([]);
    expect(RuleSuggesterOutput.safeParse(fixture('rule-suggester.ghost-line')).success).toBe(true);
  });
});

describe('the suggester input', () => {
  it('holds the evidence pack, probe statistics as P items and active rules as R items; no session ids', () => {
    const { input, evidenceIds, probeIds } = suggesterTurn(ghostLineCluster(GHOST), ghostCatalog);
    expect([...probeIds]).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect([...evidenceIds]).toEqual(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'P1', 'P2', 'P3', 'P4']);
    expect(input.text).toContain('"name": "qty"');
    expect(input.text).not.toMatch(/s_ghost_|sig-\d|node_id/);
  });
});

describe('offline rule suggester and author', () => {
  const model = new OfflineLlm();

  it('proposes the pairs-per-line rule for a bag line left at quantity 0', async () => {
    const { evidenceIds, probeIds, input } = suggesterTurn(ghostLineCluster(GHOST), ghostCatalog);
    const res = await runStructured(RULE_SUGGESTER, model, input, (o) => validateRuleSuggestion(o, evidenceIds, probeIds), noSleep);
    expect(res.run).toMatchObject({ agent: 'rule_suggester', ok: true, attempts: 1, model: 'offline-stand-in' });
    expect(res.output).toMatchObject({ propose: true, sentence: PAIRS_PER_LINE_SENTENCE });
    expect(res.output!.explanation.evidence_ids).toEqual(['E1', 'E2', 'E3', 'E4', 'P4', 'P3']);
    expect(res.output!.assumptions).toContain('A line at quantity 0 should have left the bag.');
    expect(res.output!.explanation.text).not.toMatch(/charged/);
  });

  it('proposes on qty min 0 alone, citing line_total only when it is reported', async () => {
    const noLine: ProbeCatalog = { ...ghostCatalog, probes: ghostCatalog.probes.filter((p) => p.name !== 'line_total') };
    const { evidenceIds, probeIds, input } = suggesterTurn(ghostLineCluster(GHOST), noLine);
    const res = await runStructured(RULE_SUGGESTER, model, input, (o) => validateRuleSuggestion(o, evidenceIds, probeIds), noSleep);
    expect(res.output).toMatchObject({ propose: true, sentence: PAIRS_PER_LINE_SENTENCE });
    expect(res.output!.explanation.evidence_ids).toEqual(['E1', 'E2', 'E3', 'E4', 'P3']); // P3 is qty here
  });

  it('declines, grounded, for the three existing demo issues', async () => {
    const { dead, total, checkout } = demoClusters(10);
    for (const cluster of [dead, total, checkout]) {
      for (const catalog of [emptyCatalog, cleanCatalog]) {
        const { evidenceIds, probeIds, input } = suggesterTurn(cluster, catalog);
        const res = await runStructured(RULE_SUGGESTER, model, input, (o) => validateRuleSuggestion(o, evidenceIds, probeIds), noSleep);
        expect(res.run.error).toBeNull();
        expect(res.output).toMatchObject({ propose: false, sentence: '' });
        expect(res.output!.explanation.text).toMatch(/GOOGLE_API_KEY/);
      }
    }
  });

  it('compiles the proposed sentence to sum(qty) >= count(qty), which flags exactly the ghost lines', () => {
    const probes = ['cart_total', 'discount', 'line_total', 'qty'].map((name, i) => ({ id: `P${i + 1}`, kind: 'probe', name }));
    const author = (text: string) => offlineRuleAuthor({ evidence: [{ id: 'S1', kind: 'sentence', text }, ...probes] });
    const out = author(PAIRS_PER_LINE_SENTENCE);
    expect(out).toMatchObject({ understood: true, rule_id: 'bag_lines_have_pairs', title: 'A bag line holds no pairs but stays in the bag', explanation: { evidence_ids: ['S1', 'P4'] } });
    const rule = compileRule(out, 1);
    expect(ruleText(rule)).toBe('sum(qty) ≥ count(qty)');
    expect(rule.requires).toEqual(['qty']);
    expect(checkRule(rule, { qty: [0] }, '/cart').ok).toBe(false);
    expect(checkRule(rule, { qty: [0, 1] }, '/cart').ok).toBe(false);
    expect(checkRule(rule, { qty: [1, 0] }, '/cart').ok).toBe(false);
    expect(checkRule(rule, { qty: [1] }, '/cart').ok).toBe(true);
    expect(checkRule(rule, { qty: [2, 1] }, '/cart').ok).toBe(true);
    expect(author('The number of pairs must never be less than the number of lines in the bag.').rule_id).toBe('bag_lines_have_pairs');
    expect(author('Every bag line must have at least one item.').rule_id).toBe('bag_lines_have_pairs');
    expect(offlineRuleAuthor({ evidence: [{ id: 'S1', kind: 'sentence', text: PAIRS_PER_LINE_SENTENCE }] }).understood).toBe(false);
  });

  it("does not overlap the merchant's qty_price rule: a ghost snapshot trips only bag_lines_have_pairs", () => {
    const probes = ['cart_total', 'discount', 'line_total', 'qty'].map((name, i) => ({ id: `P${i + 1}`, kind: 'probe', name }));
    const compile = (text: string) => compileRule(offlineRuleAuthor({ evidence: [{ id: 'S1', kind: 'sentence', text }, ...probes] }), 1);
    const qtyPrice = compile(RETRO_RULE_SENTENCE);
    const pairs = compile(PAIRS_PER_LINE_SENTENCE);
    expect(qtyPrice.id).toBe('bag_subtotal_per_pair_cap');
    for (const p of [1, 499_500, LINE, 1_699_500, 1_700_000]) {
      const snapshot = { line_total: [p, 0], qty: [1, 0], discount: [0], cart_total: [p] };
      expect(checkRule(qtyPrice, snapshot, '/cart')).toMatchObject({ applicable: true, ok: true });
      expect(checkRule(pairs, snapshot, '/cart')).toMatchObject({ applicable: true, ok: false });
    }
    // And the other way round: a qty_price line (100x its price at quantity 2) is not a ghost line.
    const inflated = { line_total: [139_900_000], qty: [2], discount: [0], cart_total: [139_900_000] };
    expect(checkRule(qtyPrice, inflated, '/cart').ok).toBe(false);
    expect(checkRule(pairs, inflated, '/cart').ok).toBe(true);
  });

  it('understands the three example sentences exactly as before', () => {
    const probes = ['cart_total', 'discount', 'line_total', 'qty'].map((name, i) => ({ id: `P${i + 1}`, kind: 'probe', name }));
    const rules = EXAMPLES.map((text) => compileRule(offlineRuleAuthor({ evidence: [{ id: 'S1', kind: 'sentence', text }, ...probes] }), 1));
    expect(rules.map((r) => [r.id, ruleText(r)])).toEqual([
      ['bag_subtotal_per_pair_cap', 'sum(line_total) ≤ 17,00,000 × sum(qty)'],
      ['discount_at_most_10_pct', 'discount ≤ 0.1 × sum(line_total) + 1'],
      ['cart_total_equals_lines', 'cart_total = sum(line_total) − discount (within 1)'],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// End to end: agent pass -> trigger -> suggester -> rule service draft (origin agent) -> dry run.
// ---------------------------------------------------------------------------------------------

class NullPublisher implements Publisher {
  async publish(): Promise<string> {
    return '1';
  }
  async close(): Promise<void> {}
}

let dir: string;
let blob: LocalBlobStore;
let warehouse: LocalWarehouse;
let reader: LocalWarehouseReader;
let state: LocalStateStore;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cp-suggest-'));
  blob = new LocalBlobStore(join(dir, 'gcs'), 'raw');
  warehouse = new LocalWarehouse(join(dir, 'bq'));
  reader = new LocalWarehouseReader(warehouse);
  state = new LocalStateStore(join(dir, 'firestore'));
  clock = T + 3_600_000;
});

const CART = 1_000_000;

/** Raw sessions with probes and their outcomes. ghost: 8 of 10 abandon; clean: 3 of 12; dead: 4 of 10. */
async function seedWorld(opts: { ghost?: boolean; dead?: boolean } = { ghost: true }) {
  const stores = { blob, warehouse };
  for (const [i, s] of CLEAN.entries()) {
    await seedRawSession(stores, s, T + 200_000 + i * 10_000, [i % 2 ? clean2 : clean]);
    await seedCartOutcome(warehouse, s, T + 200_000 + i * 10_000 + 500, CART, i >= 3);
  }
  if (opts.ghost) {
    for (const [i, s] of GHOST.entries()) {
      await seedRawSession(stores, s, T + i * 10_000, [clean, ghost(i)]);
      await seedCartOutcome(warehouse, s, T + i * 10_000 + 500, CART, i >= 8);
    }
    await putCluster(ghostLineCluster(GHOST));
  }
  if (opts.dead) {
    for (const [i, s] of DEAD.entries()) {
      await seedRawSession(stores, s, T + 400_000 + i * 10_000, [clean]);
      await seedCartOutcome(warehouse, s, T + 400_000 + i * 10_000 + 500, CART, i >= 4);
    }
    await putCluster(deadCluster());
  }
}

/** The dead coupon button over the DEAD sessions (dead clicks and response decay, half each). */
const deadCluster = () =>
  clusterOf(DEAD.flatMap((s) => [signal({ session_id: s }), signal({ session_id: s, detector: 'response_decay', fingerprint: 'fp-decay' }, { answered_before: 5, unanswered: 3 })]));

async function putCluster(c: Cluster) {
  await state.applyToCluster(c.tenant_id, c.cluster_id, `seed-${c.cluster_id}-${c.signal_count}-${c.updated_at}-${Object.keys(c.releases).length}`, () => c, 1);
}

const offlineModels = (): ModelSet => {
  const m = new OfflineLlm();
  return { bulk: m, reasoning: m, offline: true };
};

function ruleService(models: ModelSet = offlineModels()): RuleService {
  return createRuleService({
    state,
    warehouse,
    reader,
    blob,
    publisher: new NullPublisher(),
    signalsTopic: 'signals',
    models,
    logger: quiet,
    tenants: ['demo'],
    dryRun: { sessions: 100, days: 30 },
    rescan: { sessions: 100, days: 30, concurrency: 2 },
    revenue: REVENUE,
    runOptions: noSleep,
    now: () => clock,
  });
}

/** Wired as index.ts does: same rule service, origin agent. */
const suggestDeps = (rules: RuleService, over: Partial<RuleSuggestParams> = {}): RuleSuggestDeps => ({
  params: { ...PARAMS, ...over },
  activeRules: (t) => rules.activeRules(t),
  probeStats: (t, sessionIds) => rules.probeStats(t, sessionIds),
  draft: (t, sentence, meta) => rules.draft(t, sentence, { origin: 'agent', ...meta }),
});

function agentDeps(models: ModelSet, ruleSuggest?: RuleSuggestDeps): ServiceDeps {
  return {
    state,
    warehouse,
    reader,
    blob,
    models,
    rules: DEFAULT_PRIORITY_RULES,
    screenshotter: null,
    logger: quiet,
    tenants: ['demo'],
    rescoreMs: 10_000,
    maxPerPass: 5,
    lookbackMs: 7 * 86_400_000,
    regressionWindowMs: 86_400_000,
    revenue: REVENUE,
    loadReplay: async () => null,
    runOptions: noSleep,
    now: () => clock,
    ...(ruleSuggest ? { ruleSuggest } : {}),
  };
}

/** Recorded answers for the three finding agents (they cite E1 and E2 only), plus the suggester's. */
const recorded = (suggester: object) =>
  new RecordedLlm(
    {
      triage: [{ title: 'Remove leaves a ghost line in the bag', category: 'broken_control', confidence: 0.8, summary: { text: 's', evidence_ids: ['E1'] }, likely_cause: { text: 'c', evidence_ids: ['E2'] }, repro_steps: [{ step: 'a', evidence_ids: ['E1'] }, { step: 'b', evidence_ids: [] }] }],
      root_cause: [{ hypothesis: { text: 'h', evidence_ids: ['E2'] }, visual_check: 'not_checked', visual_notes: { text: 'n', evidence_ids: ['E1'] }, suggested_fix_area: 'qty handler' }],
      ranker: [{ rule_ids: ['checkout_friction'], tier_move: 'none', move_rule_id: '', reason: { text: 'r', evidence_ids: ['E1'] } }],
      rule_suggester: [suggester],
    },
    'gemini-3.5-flash-lite',
  );

const grow = async (c: Cluster, release: string) => {
  // A new release changes the issue's llm_key (and so the suggestion key) without touching its symptoms.
  const next = { ...c, releases: { ...c.releases, [release]: 1 }, updated_at: clock };
  await putCluster(next);
  return next;
};

describe('agent-suggested rules, end to end (synthetic sessions)', () => {
  it('offline: the ghost_line issue becomes an agent draft that hits exactly its sessions, with revenue lost', async () => {
    await seedWorld({ ghost: true });
    const cluster = ghostLineCluster(GHOST);
    const rules = ruleService();
    const service = createAgentService(agentDeps(offlineModels(), suggestDeps(rules)));
    const [result] = await service.runPass();
    expect(result).toMatchObject({ analyzed: 1, failed: 0 });

    const f = (await state.getFinding('demo', cluster.cluster_id))!;
    expect(f.revenue).toMatchObject({ status: 'ok', revenue_at_risk_minor: 5_500_000 });
    expect(f.rule_suggestion).toMatchObject({
      key: suggestionKey(f.llm_key),
      status: 'drafted',
      rule_id: 'bag_lines_have_pairs',
      sentence: PAIRS_PER_LINE_SENTENCE,
      reason: null,
      run: { agent: 'rule_suggester', model: 'offline-stand-in', ok: true, attempts: 1 },
      at: clock,
    });
    // The suggester never enters the finding's runs, version hash, or BigQuery row.
    expect(f.runs.map((r) => r.agent)).toEqual(['triage', 'root_cause', 'ranker']);
    expect(versionHash({ ...f, rule_suggestion: undefined })).toBe(f.input_hash);
    expect(JSON.stringify(toFindingRow(f, 1))).not.toContain('rule_suggestion');
    expect(await warehouse.rows('findings')).toHaveLength(1);

    const doc = (await state.getRule('demo', 'bag_lines_have_pairs'))!;
    expect(doc).toMatchObject({ active: null, title: 'A bag line holds no pairs but stays in the bag' });
    const draft = doc.draft!;
    expect(draft).toMatchObject({
      origin: 'agent',
      cluster_id: cluster.cluster_id,
      sentence: PAIRS_PER_LINE_SENTENCE,
      author: { model: 'offline-stand-in', offline: true },
      suggester: { model: 'offline-stand-in', offline: true, evidence_ids: ['E1', 'E2', 'E3', 'E4', 'P4', 'P3'] },
    });
    expect(ruleText(draft.rule)).toBe('sum(qty) ≥ count(qty)');
    expect(draft.dry_run).toMatchObject({ sessions_scanned: 22, sessions_applicable: 22, sessions_hit: 10, hits_in_issues: 10 });
    expect(draft.dry_run!.samples.every((s) => GHOST.includes(s.session_id))).toBe(true);
    // Revenue already lost: the same formula over the dry run's hits (here the issue's own sessions).
    const expected = revenueAtRisk(
      { affectedSessionIds: GHOST, affectedSessionCount: 10, route: '/cart', sessionsInAnyIssue: new Set(GHOST), outcomes: await reader.sessionOutcomes('demo', clock - 30 * 86_400_000), now: clock },
      REVENUE,
    );
    expect(draft.revenue_lost).toEqual(expected);
    // 10 sessions x ₹10,000 x (0.8 - 0.25) = ₹55,000 (synthetic).
    expect(draft.revenue_lost).toMatchObject({ status: 'ok', revenue_at_risk_minor: 5_500_000, baseline_scope: 'route' });
    expect(await warehouse.rows('signals')).toEqual([]); // a draft writes nothing live
  });

  it('with Gemini (recorded fixture): same draft path, suggester run on the bulk model, no session data in its turn', async () => {
    await seedWorld({ ghost: true });
    const cluster = ghostLineCluster(GHOST);
    const gemini = recorded(fixture('rule-suggester.ghost-line'));
    const rules = ruleService(); // the rule author stays the offline stand-in here
    const service = createAgentService(agentDeps({ bulk: gemini, reasoning: gemini, offline: false }, suggestDeps(rules)));
    await service.runPass();

    expect(gemini.calls('rule_suggester')).toBe(1);
    const f = (await state.getFinding('demo', cluster.cluster_id))!;
    expect(f.rule_suggestion).toMatchObject({ status: 'drafted', rule_id: 'bag_lines_have_pairs', run: { model: 'gemini-3.5-flash-lite', ok: true } });
    const draft = (await state.getRule('demo', 'bag_lines_have_pairs'))!.draft!;
    expect(draft).toMatchObject({ origin: 'agent', cluster_id: cluster.cluster_id, suggester: { model: 'gemini-3.5-flash-lite', offline: false, evidence_ids: ['E1', 'E2', 'E3', 'P3', 'P4', 'R1'] } });
    expect(draft.dry_run).toMatchObject({ sessions_hit: 10 });
    expect(draft.revenue_lost).toMatchObject({ status: 'ok', revenue_at_risk_minor: 5_500_000 });

    const req = gemini.requests.find((r) => r.config?.labels?.adk_agent_name === 'rule_suggester')!;
    const text = (req.contents.at(-1)?.parts ?? []).map((p) => p.text ?? '').join('');
    expect(text).toContain('"rule_id": "cart_total_matches_lines"');
    expect(text).not.toMatch(/s_ghost_|s_clean_|sig-\d|"events"/);
  });

  it('caches: a drafted suggestion is never asked again, even when the key changes', async () => {
    await seedWorld({ ghost: true });
    let cluster = ghostLineCluster(GHOST);
    const gemini = recorded(fixture('rule-suggester.ghost-line'));
    const service = createAgentService(agentDeps({ bulk: gemini, reasoning: gemini, offline: false }, suggestDeps(ruleService())));
    await service.runPass();
    const first = (await state.getFinding('demo', cluster.cluster_id))!.rule_suggestion!;

    clock += 20_000;
    await service.runPass();
    expect(gemini.calls('rule_suggester')).toBe(1);
    expect((await state.getFinding('demo', cluster.cluster_id))!.rule_suggestion).toEqual(first);

    cluster = await grow(cluster, 'demo-shop@v2');
    clock += 20_000;
    await service.runPass();
    const after = (await state.getFinding('demo', cluster.cluster_id))!;
    expect(gemini.calls('triage')).toBe(2); // the issue's nature changed, so the finding agents re-ran
    expect(gemini.calls('rule_suggester')).toBe(1);
    expect(after.rule_suggestion).toEqual(first);
    expect(after.llm_key).not.toBe(first.key);
  });

  it('caches: a declined suggestion is asked again only when the key changes', async () => {
    await seedWorld({ dead: true });
    let cluster = deadCluster();
    const gemini = recorded(fixture('rule-suggester.dead-button'));
    const service = createAgentService(agentDeps({ bulk: gemini, reasoning: gemini, offline: false }, suggestDeps(ruleService())));
    await service.runPass();
    const f = (await state.getFinding('demo', cluster.cluster_id))!;
    expect(f.rule_suggestion).toMatchObject({ status: 'declined', rule_id: null, sentence: null, reason: expect.stringMatching(/not a number/) });
    expect(await state.listRules('demo')).toEqual([]);

    clock += 20_000;
    await service.runPass();
    expect(gemini.calls('rule_suggester')).toBe(1);

    cluster = await grow(cluster, 'demo-shop@v2');
    clock += 20_000;
    await service.runPass();
    expect(gemini.calls('rule_suggester')).toBe(2);
    const again = (await state.getFinding('demo', cluster.cluster_id))!;
    expect(again.rule_suggestion).toMatchObject({ status: 'declined', key: suggestionKey(again.llm_key) });
  });

  it('does not ask when the trigger does not trip, and keeps what the issue had', async () => {
    await seedWorld({ ghost: true });
    const cluster = ghostLineCluster(GHOST);
    const gemini = recorded(fixture('rule-suggester.ghost-line'));
    const service = createAgentService(agentDeps({ bulk: gemini, reasoning: gemini, offline: false }, suggestDeps(ruleService(), { minSessions: 11 })));
    await service.runPass();
    expect(gemini.calls('rule_suggester')).toBe(0);
    expect((await state.getFinding('demo', cluster.cluster_id))!.rule_suggestion).toBeUndefined();
  });

  it('never fails the finding pass: a store hiccup before the model is asked is not remembered, so the next pass tries again', async () => {
    await seedWorld({ ghost: true });
    const cluster = ghostLineCluster(GHOST);
    const rules = ruleService();
    const broken: RuleSuggestDeps = { ...suggestDeps(rules), probeStats: async () => Promise.reject(new Error('store unavailable')) };
    const [result] = await createAgentService(agentDeps(offlineModels(), broken)).runPass();
    expect(result).toMatchObject({ analyzed: 1, failed: 0 });
    const f = (await state.getFinding('demo', cluster.cluster_id))!;
    expect(f.rule_suggestion).toBeUndefined();
    expect(f.triage).not.toBeNull();

    clock += 60_000; // past AGENT_RESCORE_MS, with the store back
    await createAgentService(agentDeps(offlineModels(), suggestDeps(rules))).runPass();
    expect((await state.getFinding('demo', cluster.cluster_id))!.rule_suggestion).toMatchObject({ status: 'drafted', rule_id: 'bag_lines_have_pairs' });
  });

  it('a model that could not be reached is not remembered: the next pass asks again', async () => {
    await seedWorld({ ghost: true });
    const cluster = ghostLineCluster(GHOST);
    const gemini = recorded(fixture('rule-suggester.ghost-line'));
    let down = true;
    let tries = 0;
    const answer = gemini.generateContentAsync.bind(gemini);
    gemini.generateContentAsync = async function* (req) {
      if (req.config?.labels?.adk_agent_name === 'rule_suggester') {
        tries += 1;
        if (down) {
          yield { errorCode: 'PERMISSION_DENIED', errorMessage: 'no access' }; // not retryable: no back-off
          return;
        }
      }
      yield* answer(req);
    };
    const service = createAgentService(agentDeps({ bulk: gemini, reasoning: gemini, offline: false }, suggestDeps(ruleService())));
    await service.runPass();
    expect(tries).toBe(1);
    expect((await state.getFinding('demo', cluster.cluster_id))!.rule_suggestion).toBeUndefined();

    down = false;
    clock += 20_000;
    await service.runPass();
    expect(tries).toBe(2);
    expect((await state.getFinding('demo', cluster.cluster_id))!.rule_suggestion).toMatchObject({ status: 'drafted', rule_id: 'bag_lines_have_pairs' });
  });

  it('an answer the validator rejected is remembered as failed until the key changes', async () => {
    await seedWorld({ ghost: true });
    const cluster = ghostLineCluster(GHOST);
    const gemini = recorded({ ...fixture('rule-suggester.ghost-line'), explanation: { text: 'x', evidence_ids: ['E1', 'P9'] } });
    const service = createAgentService(agentDeps({ bulk: gemini, reasoning: gemini, offline: false }, suggestDeps(ruleService())));
    await service.runPass();
    expect(gemini.calls('rule_suggester')).toBe(2); // the first answer and the validator's one retry
    expect((await state.getFinding('demo', cluster.cluster_id))!.rule_suggestion).toMatchObject({ status: 'failed', reason: expect.stringMatching(/not supplied: P9/), run: { ok: false, attempts: 2 } });

    clock += 20_000;
    await service.runPass();
    expect(gemini.calls('rule_suggester')).toBe(2);
    expect(await state.listRules('demo')).toEqual([]);
  });

  it('a draft that could not be written (not a rule service verdict) is not remembered: the next pass drafts it', async () => {
    await seedWorld({ ghost: true });
    const cluster = ghostLineCluster(GHOST);
    const rules = ruleService();
    let down = true;
    const flaky: RuleSuggestDeps = {
      ...suggestDeps(rules),
      draft: async (t, sentence, meta) => {
        if (down) throw new Error('state store unavailable');
        return rules.draft(t, sentence, { origin: 'agent', ...meta });
      },
    };
    const service = createAgentService(agentDeps(offlineModels(), flaky));
    expect((await service.runPass())[0]).toMatchObject({ analyzed: 1, failed: 0 });
    expect((await state.getFinding('demo', cluster.cluster_id))!.rule_suggestion).toBeUndefined();

    down = false;
    clock += 20_000;
    await service.runPass();
    expect((await state.getFinding('demo', cluster.cluster_id))!.rule_suggestion).toMatchObject({ status: 'drafted', rule_id: 'bag_lines_have_pairs' });
  });

  it('reads no rules for a data-rule issue anchored on a built-in rule; a tenant-rule anchor still checks the active rules', async () => {
    await seedWorld({});
    const { total, ids: demoIds } = demoClusters(10);
    for (const [i, s] of demoIds('total').entries()) {
      await seedRawSession({ blob, warehouse }, s, T + 600_000 + i * 10_000, [clean]);
      await seedCartOutcome(warehouse, s, T + 600_000 + i * 10_000 + 500, CART, i >= 5);
    }
    const tenantAnchored = { ...total, cluster_id: 'c_tenant_rule_issue', anchor: 'bag_subtotal_per_pair_cap' };
    await putCluster(total);
    await putCluster(tenantAnchored);
    const rules = ruleService();
    let reads = 0;
    const counting: RuleSuggestDeps = { ...suggestDeps(rules), activeRules: async (t) => ((reads += 1), rules.activeRules(t)) };
    await createAgentService(agentDeps(offlineModels(), counting)).runPass();

    const builtin = (await state.getFinding('demo', total.cluster_id))!;
    expect(builtin.revenue.status).toBe('ok'); // so only the built-in anchor stops it
    expect(builtin.rule_suggestion).toBeUndefined();
    expect(reads).toBe(1); // the tenant-anchored issue only
    expect((await state.getFinding('demo', tenantAnchored.cluster_id))!.rule_suggestion).toMatchObject({ status: 'declined' });
  });
});

describe('agent draft guards in the rule service', () => {
  const meta: RuleAuthorMeta = { model: 'offline-stand-in', prompt_hash: 'x', offline: true, explanation: 'e', evidence_ids: ['E1', 'P4'], assumptions: [], attempts: 1, ms: 0 };

  it("never replaces a merchant's pending draft (the suggestion fails instead)", async () => {
    await seedWorld({ ghost: true });
    const cluster = ghostLineCluster(GHOST);
    const rules = ruleService();
    const human = await rules.draft('demo', PAIRS_PER_LINE_SENTENCE);
    expect(human.draft).toMatchObject({ origin: 'human', cluster_id: null, suggester: null, revenue_lost: { status: 'ok', revenue_at_risk_minor: 5_500_000 } });

    clock += 1_000;
    const [result] = await createAgentService(agentDeps(offlineModels(), suggestDeps(rules))).runPass();
    expect(result).toMatchObject({ analyzed: 1, failed: 0 });
    const f = (await state.getFinding('demo', cluster.cluster_id))!;
    expect(f.rule_suggestion).toMatchObject({ status: 'failed', rule_id: null, sentence: PAIRS_PER_LINE_SENTENCE, reason: expect.stringMatching(/pending draft/) });
    expect((await state.getRule('demo', 'bag_lines_have_pairs'))!.draft).toEqual(human.draft);
  });

  it('never proposes edits to a live rule', async () => {
    await seedWorld({ ghost: true });
    const rules = ruleService();
    const doc = await rules.draft('demo', PAIRS_PER_LINE_SENTENCE);
    await rules.approve('demo', doc.rule_id, 1, 'test-merchant');
    await rules.idle();
    await expect(rules.draft('demo', PAIRS_PER_LINE_SENTENCE, { origin: 'agent', cluster_id: 'c1', suggester: meta })).rejects.toMatchObject({ code: 'conflict', status: 409, message: expect.stringMatching(/is live/) });
    // A merchant may still edit it (version 2), as before.
    expect((await rules.draft('demo', PAIRS_PER_LINE_SENTENCE)).draft).toMatchObject({ origin: 'human', rule: { version: 2 } });
  });

  it('refuses an agent draft that flags no session; a human draft of the same sentence is kept as before', async () => {
    await seedWorld({ ghost: true });
    const rules = ruleService();
    const sentence = 'The discount must never be more than 10% of the bag.';
    const err = await rules.draft('demo', sentence, { origin: 'agent', cluster_id: 'c1', suggester: meta }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuleError);
    expect(err).toMatchObject({ code: 'no_hits', status: 422 });
    expect(await state.getRule('demo', 'discount_at_most_10_pct')).toBeNull();

    const human = await rules.draft('demo', sentence);
    expect(human.draft).toMatchObject({ origin: 'human', revenue_lost: null, dry_run: { sessions_hit: 0 } });
  });

  it('never re-proposes a rule a person discarded, even after the issue changes', async () => {
    await seedWorld({ ghost: true });
    let cluster = ghostLineCluster(GHOST);
    const rules = ruleService();
    const service = createAgentService(agentDeps(offlineModels(), suggestDeps(rules)));
    await service.runPass();
    const f = (await state.getFinding('demo', cluster.cluster_id))!;
    expect(f.rule_suggestion).toMatchObject({ status: 'drafted', rule_id: 'bag_lines_have_pairs' });
    await rules.reject('demo', 'bag_lines_have_pairs');

    // The finding's own memory (drafted) already stops a re-ask; drop it, as a rebuilt hot copy would, so
    // the rule service's guard is what is tested. The session count doubles, so the key changes too.
    const { rule_suggestion: _forgotten, ...rebuilt } = f;
    await state.putFinding(rebuilt);
    cluster = { ...cluster, session_count: 20, updated_at: clock };
    await putCluster(cluster);
    clock += 20_000;
    await service.runPass();

    const after = (await state.getFinding('demo', cluster.cluster_id))!;
    expect(after.llm_key).not.toBe(f.llm_key);
    expect(after.rule_suggestion).toMatchObject({ key: suggestionKey(after.llm_key), status: 'failed', rule_id: null, sentence: PAIRS_PER_LINE_SENTENCE, reason: expect.stringMatching(/discarded by a person/) });
    expect(await state.getRule('demo', 'bag_lines_have_pairs')).toMatchObject({ draft: null, active: null });
  });

  it('a second suggestion for the same issue while its own draft is pending records drafted and writes nothing', async () => {
    await seedWorld({ ghost: true });
    const cluster = ghostLineCluster(GHOST);
    const rules = ruleService();
    const writes: string[] = [];
    const putRule = state.putRule.bind(state);
    state.putRule = async (doc) => {
      writes.push(doc.rule_id);
      return putRule(doc);
    };
    const service = createAgentService(agentDeps(offlineModels(), suggestDeps(rules)));
    await service.runPass();
    expect(writes).toEqual(['bag_lines_have_pairs']);
    const pending = await state.getRule('demo', 'bag_lines_have_pairs');

    const { rule_suggestion: _forgotten, ...rebuilt } = (await state.getFinding('demo', cluster.cluster_id))!;
    await state.putFinding(rebuilt);
    clock += 20_000;
    await service.runPass();
    expect((await state.getFinding('demo', cluster.cluster_id))!.rule_suggestion).toMatchObject({ status: 'drafted', rule_id: 'bag_lines_have_pairs', at: clock });
    expect(writes).toHaveLength(1);
    expect(await state.getRule('demo', 'bag_lines_have_pairs')).toEqual(pending);
  });

  it("revenue lost never counts another issue's sessions in the baseline (rule 9)", async () => {
    await seedWorld({ ghost: true, dead: true });
    const doc = await ruleService().draft('demo', PAIRS_PER_LINE_SENTENCE, { origin: 'agent', cluster_id: ghostLineCluster(GHOST).cluster_id, suggester: meta });
    expect(doc.draft!.dry_run).toMatchObject({ sessions_scanned: 32, sessions_hit: 10 });
    // Baseline: CLEAN only (12 finished carts, 3 abandoned). The 10 DEAD sessions (4 abandoned) sit in the
    // dead-button issue, so they stay out even though they are unaffected by this rule and on /cart.
    expect(doc.draft!.revenue_lost).toMatchObject({ status: 'ok', affected_decided: 10, baseline_scope: 'route', baseline_decided: 12, baseline_abandoned: 3, abandonment_baseline: 0.25, revenue_at_risk_minor: 5_500_000 });
    // Were the issue sessions not excluded, the baseline would hold 22 sessions and this test would fail.
    const outcomes = await reader.sessionOutcomes('demo', clock - 30 * 86_400_000);
    const leaky = revenueAtRisk({ affectedSessionIds: GHOST, affectedSessionCount: 10, route: '/cart', sessionsInAnyIssue: new Set(), outcomes, now: clock }, REVENUE);
    expect(leaky).toMatchObject({ baseline_decided: 22, baseline_abandoned: 7 });
  });

  it('reads probe statistics over the given sessions only (numbers, from raw)', async () => {
    await seedWorld({ ghost: true });
    const stats = await ruleService().probeStats('demo', [...GHOST, 's_missing_0001']);
    expect(stats.sessions).toBe(10);
    expect(stats.probes.find((p) => p.name === 'qty')).toMatchObject({ min: 0, max: 1, values_per_snapshot: { min: 1, max: 2 } });
    expect(stats.probes.find((p) => p.name === 'line_total')).toMatchObject({ min: 0, max: LINE });
  });
});

it('the suggestion key follows the issue key and the suggester prompt version', () => {
  const c = ghostLineCluster(GHOST);
  const m = offlineModels();
  const key = llmKey(c, DEFAULT_PRIORITY_RULES, m, false);
  expect(suggestionKey(key)).toHaveLength(20);
  expect(suggestionKey(key)).not.toBe(suggestionKey(llmKey({ ...c, releases: { ...c.releases, x: 1 } }, DEFAULT_PRIORITY_RULES, m, false)));
  expect(SUGGEST_PROMPT_VERSION).toBe('s1');
});
