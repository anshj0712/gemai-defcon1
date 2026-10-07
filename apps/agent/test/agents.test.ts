import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RankOutput, RootCauseOutput, TriageOutput } from '@cp/schema';
import { RANKER, rankerInput, ROOT_CAUSE, rootCauseInput, TRIAGE, triageInput } from '../src/agents/prompts.js';
import { buildEvidence } from '../src/evidence.js';
import { citedIds, validateRank, validateRootCause, validateTriage } from '../src/grounding.js';
import { OfflineLlm } from '../src/llm/offline.js';
import { parseJsonText, promptHash, runStructured } from '../src/llm/run-agent.js';
import { baseTier, DEFAULT_PRIORITY_RULES, revenueAtRisk } from '../src/scoring/index.js';
import { demoClusters, outcome, RecordedLlm, signal, T } from './helpers.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as object;
const noSleep = { sleep: async () => undefined };

function deadEvidence() {
  const { dead } = demoClusters(10);
  const signals = dead.evidence.map((e) => signal({ signal_id: e.signal_id, session_id: e.session_id, detector: e.detector }, e.detector === 'response_decay' ? { answered_before: 5 } : {}));
  const revenue = revenueAtRisk({ affectedSessionIds: dead.sessions, affectedSessionCount: dead.session_count, route: '/cart', sessionsInAnyIssue: new Set(dead.sessions), outcomes: dead.sessions.map((s) => outcome(s)), now: T + 3_600_000 });
  return { cluster: dead, evidence: buildEvidence({ cluster: dead, signals, revenue, regression: false }), revenue };
}

describe('evidence pack', () => {
  it('numbers items in a fixed order and keeps session and signal ids away from the model', () => {
    const { evidence } = deadEvidence();
    expect(evidence.map((e) => `${e.id}:${e.kind}`)).toEqual(['E1:issue', 'E2:signal', 'E3:signal', 'E4:signal', 'E5:signal', 'E6:signal', 'E7:release', 'E8:impact']);
    const text = triageInput(evidence).text;
    expect(text).not.toMatch(/s_dead_|sig-\d/);
    expect(text).not.toMatch(/node_id/);
    expect(text).toMatch(/Synthetic demo data/);
  });
});

describe('grounding validator', () => {
  const ids = new Set(['E1', 'E2', 'E3']);

  it('rejects an output that cites an evidence id that was not supplied', () => {
    const out = TriageOutput.parse({
      title: 'Coupon button', category: 'broken_control', confidence: 0.8,
      summary: { text: 's', evidence_ids: ['E1'] }, likely_cause: { text: 'c', evidence_ids: ['E9'] },
      repro_steps: [{ step: 'a', evidence_ids: ['E2'] }, { step: 'b', evidence_ids: [] }],
    });
    expect(citedIds(out)).toEqual(['E1', 'E9', 'E2']);
    expect(validateTriage(out, ids)).toEqual([expect.stringMatching(/not supplied: E9/)]);
  });

  it('requires visual verdicts to cite the screenshot, and not_checked without one', () => {
    const base = { hypothesis: { text: 'h', evidence_ids: ['E1'] }, visual_notes: { text: 'n', evidence_ids: ['E1'] }, suggested_fix_area: 'x' };
    expect(validateRootCause(RootCauseOutput.parse({ ...base, visual_check: 'confirmed' }), ids, null)).toEqual([expect.stringMatching(/not_checked/)]);
    expect(validateRootCause(RootCauseOutput.parse({ ...base, visual_check: 'confirmed' }), ids, 'E3')).toEqual([expect.stringMatching(/cite the screenshot E3/)]);
    expect(validateRootCause(RootCauseOutput.parse({ ...base, visual_check: 'unclear' }), ids, 'E3')).toEqual([]);
  });

  it('rejects unknown priority rules and moves without a cited rule', () => {
    const r = (o: object) => RankOutput.parse({ rule_ids: ['checkout_friction'], tier_move: 'none', move_rule_id: '', reason: { text: 'r', evidence_ids: ['E1'] }, ...o });
    expect(validateRank(r({}), ids, DEFAULT_PRIORITY_RULES)).toEqual([]);
    expect(validateRank(r({ rule_ids: ['vip_customers'] }), ids, DEFAULT_PRIORITY_RULES)[0]).toMatch(/do not exist/);
    expect(validateRank(r({ tier_move: 'up', move_rule_id: 'pricing_error' }), ids, DEFAULT_PRIORITY_RULES)[0]).toMatch(/one of the cited rule_ids/);
  });
});

describe('running an ADK agent', () => {
  it('returns validated JSON and records model, prompt hash and attempts', async () => {
    const { evidence } = deadEvidence();
    const model = new RecordedLlm({ triage: [fixture('triage.dead-button')] });
    const res = await runStructured(TRIAGE, model, triageInput(evidence), (o) => validateTriage(o, new Set(evidence.map((e) => e.id))), noSleep);
    expect(res.output?.title).toBe('Apply Coupon stops working after five presses on /cart');
    expect(res.run).toMatchObject({ agent: 'triage', model: 'recorded-fixture', ok: true, attempts: 1, prompt_hash: promptHash('recorded-fixture', TRIAGE.instruction, triageInput(evidence)) });
    // ADK sent the schema as Gemini structured output, the instruction as the system prompt, and no history.
    const req = model.requests[0]!;
    expect(req.config).toMatchObject({ responseMimeType: 'application/json', temperature: 0 });
    expect(JSON.stringify(req.config?.responseSchema)).toMatch(/repro_steps/);
    expect(String(req.config?.systemInstruction)).toMatch(/evidence_ids/);
    expect(req.contents).toHaveLength(1);
  });

  it('retries once with the validator message, then succeeds', async () => {
    const { evidence } = deadEvidence();
    const bad = { ...fixture('triage.dead-button'), likely_cause: { text: 'made up', evidence_ids: ['E42'] } };
    const model = new RecordedLlm({ triage: [bad, fixture('triage.dead-button')] });
    const res = await runStructured(TRIAGE, model, triageInput(evidence), (o) => validateTriage(o, new Set(evidence.map((e) => e.id))), noSleep);
    expect(res.run).toMatchObject({ ok: true, attempts: 2 });
    const retryText = model.requests[1]!.contents[0]!.parts!.map((p) => p.text).join('');
    expect(retryText).toMatch(/rejected by the validator: cites evidence ids that were not supplied: E42/);
  });

  it('fails closed after the retry', async () => {
    const { evidence } = deadEvidence();
    const model = new RecordedLlm({ triage: ['not json at all'] });
    const res = await runStructured(TRIAGE, model, triageInput(evidence), () => [], noSleep);
    expect(res.output).toBeNull();
    expect(res.run).toMatchObject({ ok: false, attempts: 2, error: 'the answer was not valid JSON' });
  });

  it('backs off on rate limits without spending the validation retry', async () => {
    const { evidence } = deadEvidence();
    let calls = 0;
    const model = new RecordedLlm({ triage: [fixture('triage.dead-button')] });
    const original = model.generateContentAsync.bind(model);
    model.generateContentAsync = async function* (req) {
      calls += 1;
      if (calls <= 2) {
        yield { errorCode: '429', errorMessage: 'RESOURCE_EXHAUSTED' };
        return;
      }
      yield* original(req);
    };
    const waits: number[] = [];
    const res = await runStructured(TRIAGE, model, triageInput(evidence), () => [], { sleep: async (ms) => void waits.push(ms), backoffMs: 10 });
    expect(res.run).toMatchObject({ ok: true, attempts: 1 });
    expect(waits).toEqual([10, 20]);
  });

  it('accepts JSON in a fenced block', () => {
    expect(parseJsonText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
});

describe('offline stand-in', () => {
  it('produces grounded, valid output for all three demo bugs and every agent', async () => {
    const model = new OfflineLlm();
    for (const c of Object.values(demoClusters(4)).filter((v) => typeof v === 'object' && 'cluster_id' in v)) {
      const cluster = c as ReturnType<typeof demoClusters>['dead'];
      const revenue = revenueAtRisk({ affectedSessionIds: cluster.sessions, affectedSessionCount: cluster.session_count, route: cluster.route, sessionsInAnyIssue: new Set(), outcomes: [], now: T });
      const evidence = buildEvidence({ cluster, signals: [], revenue, regression: false });
      const ids = new Set(evidence.map((e) => e.id));
      const t = await runStructured(TRIAGE, model, triageInput(evidence), (o) => validateTriage(o, ids), noSleep);
      expect(t.run.error).toBeNull();
      const rc = await runStructured(ROOT_CAUSE, model, rootCauseInput(evidence, t.output, null), (o) => validateRootCause(o, ids, null), noSleep);
      expect(rc.output?.visual_check).toBe('not_checked');
      const base = baseTier(cluster, DEFAULT_PRIORITY_RULES);
      const rk = await runStructured(RANKER, model, rankerInput(evidence, { base_tier: base.tier, base_rule_ids: base.ruleIds, revenue, triage: t.output }, DEFAULT_PRIORITY_RULES), (o) => validateRank(o, ids, DEFAULT_PRIORITY_RULES), noSleep);
      expect(rk.output).toMatchObject({ tier_move: 'none', rule_ids: base.ruleIds.slice(0, 3) });
    }
  });
});
