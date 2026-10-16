import { RuleSuggesterOutput, ruleText, type EvidenceItem, type InvariantRule, type RevenueAtRisk, type TriageOutput } from '@cp/schema';
import { forModel } from '../evidence.js';
import type { AgentInput, AgentSpec } from '../llm/run-agent.js';
import type { ProbeCatalog } from '../rules/evaluate.js';
import { INPUT_MARKER } from './prompts.js';

/**
 * The rule suggester (ARCHITECTURE.md section 6, agent-suggested rules): for one recurring issue that a
 * deterministic trigger picked, decide whether a standing rule over the store's probe values would catch
 * the defect behind it and, if so, phrase it as one plain-English sentence. It never writes a rule: the
 * sentence goes to the rule author exactly as a merchant's would, then the dry run, then a person
 * approves it (AGENTS.md rule 1). Bump SUGGEST_PROMPT_VERSION on any prompt or schema change; it is
 * part of the suggestion's cache key.
 */
export const SUGGEST_PROMPT_VERSION = 's1';

export const RULE_SUGGESTER: AgentSpec<typeof RuleSuggesterOutput> = {
  name: 'rule_suggester',
  schema: RuleSuggesterOutput,
  instruction: [
    'You work for a checkout monitoring service that finds bugs in an online store from recorded, privacy-masked shopper sessions.',
    "You receive structured input only: one recurring issue as evidence items (E1, E2, ...: detector facts, CSS selectors, error signatures, numbers), statistics of the numbers the store's pages reported in this issue's own sessions (probes P1, P2, ...), and the rules that already exist (R1, ...). You never see pages, recordings, or shopper data.",
    'All sessions and amounts are synthetic demo data. Reply with JSON only, matching the response schema.',
    '',
    'Your job: decide whether a standing rule over the numbers the store\'s pages report (the probes) would catch the defect behind this issue, and if so phrase that rule as one plain-English sentence a merchant would write. Another agent turns the sentence into a rule, a dry run shows what it would flag, and a person approves it. You only propose.',
    'Probes are numbers a page reports when its content changes. Money is in minor units of the currency (₹1 = 100). Counts are whole numbers. A probe can carry several values per snapshot, one per bag line for example. Each probe item gives how many snapshots carry it, values per snapshot, and min, median and max over this issue\'s sessions.',
    '',
    '- propose: true only when all three hold: (1) the probe statistics show a value that is impossible or inconsistent for a shop, for example a count of 0 where every line should hold at least 1, or a negative amount; (2) a rule over the listed probes would catch it; (3) no existing rule (R) already checks it. Otherwise false. A control that stops responding, an error, or a slow page is not a number a rule can check, so propose false for those unless the probes themselves show the impossible value.',
    '- sentence: when propose is true, one sentence a merchant would write, in plain shop words (bag, line, pair, total, discount); probe names are not needed. Never invent amounts, prices, limits, or facts that are not in the input. Prefer a rule that holds without a number only the merchant knows (for example "every line must hold at least one pair") over one that needs a price cap. When propose is false, an empty string.',
    '- explanation: one or two sentences on why, or why not. Cite in evidence_ids the E ids that show the shopper behaviour, the P ids of the numbers you rely on, and the R ids of existing rules you compared against.',
    '- assumptions: what you had to assume (what a probe means, units), at most five.',
    'Use only ids that appear in the input. Never invent ids.',
  ].join('\n'),
};

export interface RuleSuggesterFacts {
  triage: TriageOutput | null;
  revenue: RevenueAtRisk;
}

/**
 * The suggester's user turn: the issue's evidence pack (E ids unchanged; the screenshot item is left out
 * because no image is attached), triage and revenue figures, probe statistics over this issue's sessions
 * (P ids, numbers only), and the active rules (R ids). Supplied ids = E + P + R.
 */
export function ruleSuggesterInput(
  evidence: readonly EvidenceItem[],
  facts: RuleSuggesterFacts,
  probes: ProbeCatalog,
  rules: readonly InvariantRule[],
): { input: AgentInput; evidenceIds: Set<string>; probeIds: Set<string> } {
  const items = evidence.filter((e) => e.kind !== 'screenshot');
  const probeIds = probes.probes.map((_, i) => `P${i + 1}`);
  const ruleIds = rules.map((_, i) => `R${i + 1}`);
  const payload = {
    triage: facts.triage ? { title: facts.triage.title, category: facts.triage.category, summary: facts.triage.summary.text } : null,
    revenue_at_risk: { status: facts.revenue.status, minor_units: facts.revenue.revenue_at_risk_minor, currency: facts.revenue.currency },
    /** This issue's sessions whose probe snapshots the statistics below come from. */
    sessions_read: probes.sessions,
    currency: probes.currencies[0] ?? null,
    evidence: [
      ...forModel(items),
      ...probes.probes.map((p, i) => ({
        id: probeIds[i]!,
        kind: 'probe',
        name: p.name,
        snapshots: p.snapshots,
        values_per_snapshot: p.values_per_snapshot,
        min: p.min,
        median: p.median,
        max: p.max,
        routes: p.routes,
      })),
      ...rules.map((r, i) => ({ id: ruleIds[i]!, kind: 'rule', rule_id: r.id, title: r.title, rule: ruleText(r) })),
    ],
  };
  const text = `Decide whether this recurring issue deserves a standing rule.\n\n${INPUT_MARKER}\n${JSON.stringify(payload, null, 1)}`;
  return { input: { text }, evidenceIds: new Set([...items.map((e) => e.id), ...probeIds, ...ruleIds]), probeIds: new Set(probeIds) };
}
