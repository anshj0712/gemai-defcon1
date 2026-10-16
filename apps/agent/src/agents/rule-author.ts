import { RuleAuthorOutput, ruleText, type InvariantRule } from '@cp/schema';
import type { AgentInput, AgentSpec } from '../llm/run-agent.js';
import type { ProbeCatalog } from '../rules/evaluate.js';
import { INPUT_MARKER } from './prompts.js';

/**
 * The rule author (ARCHITECTURE.md sections 5 and 6): one merchant sentence in, one invariant rule over
 * probe values out. It only drafts. Code compiles and validates the rule, a dry run shows what it would
 * flag, and a person approves it before anything is re-scanned (AGENTS.md rule 1).
 * Bump RULE_PROMPT_VERSION on any prompt or schema change.
 */
export const RULE_PROMPT_VERSION = 'r4.2';

export const RULE_AUTHOR: AgentSpec<typeof RuleAuthorOutput> = {
  name: 'rule_author',
  schema: RuleAuthorOutput,
  instruction: [
    'You work for a checkout monitoring service. A merchant describes, in plain English, something that must always hold in their store. You turn it into an invariant rule that code checks against probe values recorded from shopper sessions.',
    'You receive structured input only: the sentence (S1), the probes the store reports with their ranges (P1, P2, ...), the rules that already exist (R1, ...), and the known routes. You never see pages, recordings, or shopper data.',
    'All data is synthetic demo data. Reply with JSON only, matching the response schema.',
    '',
    'Probes are numbers a session reports. Money is in minor units of the currency (₹1 = 100, so ₹17,000 = 1700000). Counts are whole numbers. A probe can carry several values per snapshot, one per bag line for example: "sum" adds them, "count" counts them, "probe" reads one (index 0 is the first).',
    'Each probe has a source. declared: the store reports it from a page element. recorded: read from an element of the recorded page (same meaning). request: one network call, named req_<method>_<path>_ms (how long it took, in milliseconds) and req_<method>_<path>_status (its HTTP status). A sentence about a call being slow or failing maps to a request probe, for example "payment must answer within 3 seconds" -> req_post_api_payment_authorize_ms lte 3000.',
    'A rule reads: (left terms added up) op (right terms added up), with op eq, lte or gte. Each term is coef x (kind probe | sum | count | const). Use coef -1 to subtract; a const term carries its number in value (minor units for money) with coef 1. Fields that do not apply are empty strings, 0, or false.',
    '',
    '- understood: false when the sentence cannot be checked with the listed probes (it needs data no probe carries, or it is not a rule). Then say why in explanation and leave the other fields empty.',
    '- rule_id: a new snake_case id naming the rule. Do not reuse an existing rule id.',
    '- title: what is wrong when the rule fails, as a merchant would read it in an issue title, at most 90 characters.',
    '- left, right, op: the rule. Prefer sum over a per-line probe when the sentence is about the whole bag.',
    '- default_zero: true only for a kind probe term whose probe may be missing when its value is zero (for example no discount applied).',
    '- tolerance_minor: allowed slack in minor units for rounding (eq: |left - right| <= t; lte: left <= right + t; gte: left >= right - t). 0 unless rounding or the sentence calls for it.',
    '- routes: an empty list unless the merchant limits the rule to certain pages; then only routes from the input.',
    '- highlight_probe: the probe a person should look at when the rule fails, usually on the left.',
    '- explanation: one or two sentences mapping the merchant\'s words to the probes. Cite S1 and every probe id (P...) you used in evidence_ids, and R ids of existing rules you compared against. Use only ids from the input.',
    '- assumptions: what you had to assume (units, which probe means "subtotal"), at most five.',
    'Never invent probes, routes, or ids.',
  ].join('\n'),
};

/** Evidence ids the rule author may cite, by kind. */
export interface RuleAuthorEvidence {
  sentenceId: string;
  /** probe name -> evidence id */
  probeIds: Map<string, string>;
  ruleIds: string[];
  all: Set<string>;
}

export function ruleAuthorInput(sentence: string, catalog: ProbeCatalog, existing: readonly InvariantRule[]): { input: AgentInput; evidence: RuleAuthorEvidence } {
  const probeIds = new Map(catalog.probes.map((p, i) => [p.name, `P${i + 1}`]));
  const ruleIds = existing.map((_, i) => `R${i + 1}`);
  const payload = {
    evidence: [
      { id: 'S1', kind: 'sentence', text: sentence },
      ...catalog.probes.map((p) => ({
        id: probeIds.get(p.name)!,
        kind: 'probe',
        name: p.name,
        source: p.source,
        snapshots: p.snapshots,
        values_per_snapshot: p.values_per_snapshot,
        min: p.min,
        median: p.median,
        max: p.max,
        routes: p.routes,
      })),
      ...existing.map((r, i) => ({ id: ruleIds[i]!, kind: 'rule', rule_id: r.id, title: r.title, rule: ruleText(r) })),
    ],
    currency: catalog.currencies[0] ?? null,
    routes: catalog.routes,
  };
  const text = `Turn the merchant's sentence (S1) into one invariant rule.\n\n${INPUT_MARKER}\n${JSON.stringify(payload, null, 1)}`;
  return { input: { text }, evidence: { sentenceId: 'S1', probeIds, ruleIds, all: new Set(['S1', ...probeIds.values(), ...ruleIds]) } };
}
