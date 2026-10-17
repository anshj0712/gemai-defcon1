import { ChurnAnalystOutput, CHURN_REASONS, PROBE_NAME, REQUEST_PROBE_PREFIX, ruleText, type InvariantRule, type RevenueAtRisk, type RuleFeedback } from '@cp/schema';
import { citationErrors, SENTENCE_LIMITS } from '../grounding.js';
import type { AgentInput, AgentSpec } from '../llm/run-agent.js';
import type { ProbeCatalog } from '../rules/evaluate.js';
import type { Segment } from '../watch/contrast.js';
import { INPUT_MARKER } from './prompts.js';

/**
 * The churn analyst (the churn watcher's Gemini step). Code has already found a segment of shoppers who leave
 * far more often than everyone else, past a threshold on one number, and checked it is not chance. The analyst
 * judges whether that number plausibly drives shoppers away, labels the churn reason, names a probe for a page
 * element nobody probes yet, and writes the rule as one sentence for the rule author. It never decides what is a
 * finding (AGENTS.md rule 1): a person approves the probe and rule, then detectors find the sessions.
 * Bump WATCH_PROMPT_VERSION on any prompt or schema change.
 */
export const WATCH_PROMPT_VERSION = 'w1';

export const CHURN_ANALYST: AgentSpec<typeof ChurnAnalystOutput> = {
  name: 'churn_analyst',
  schema: ChurnAnalystOutput,
  instruction: [
    'You work for a checkout monitoring service that watches recorded, privacy-masked shopper sessions of an online store for what makes shoppers leave.',
    'You receive structured input only: one candidate (H1) that code found, the numbers the store reports (probes P1, P2, ...), the rules that already exist (R1, ...), a merchant\'s past verdicts on earlier hypotheses (F1, ...), and the list of churn reasons. You never see pages, recordings, text, or shopper data.',
    'All sessions and amounts are synthetic demo data. Reply with JSON only, matching the response schema.',
    '',
    'H1 is a number one page shows or one network call takes, and a threshold: shoppers whose sessions reached it (the segment) abandoned their cart far more often than the others, and code checked the gap is very unlikely to be chance. Money is in minor units (₹1 = 100). Units: money, count (a whole number shown on the page, for example days), ms (how long a call took), status (an HTTP status).',
    'A number nobody probes yet has source "discovered": it was read from the recorded page by its CSS selector. Request numbers are named req_<method>_<path>_ms or _status.',
    '',
    '- propose: true when the number is something a shopper sees or waits for, and a higher (or lower) value plausibly makes them leave: a fee, a price, a delivery time, a slow payment, a slow page. False when the link is implausible (a shoe size, a product count, an order number), or when an existing rule (R) already checks it, or when a merchant\'s feedback (F) says this is expected.',
    '- churn_reason: the closest reason from the list.',
    '- title: the suspected problem as a merchant reads it, for example "Unexpected ₹499 delivery fee at checkout", at most 90 characters.',
    '- probe_name: when H1\'s source is discovered, a short snake_case name for the number (delivery_fee, delivery_days); else an empty string.',
    '- sentence: when propose is true, one plain sentence that names the probe exactly (probe_name for a discovered number, else H1\'s name) and sets a limit, for example "The delivery_fee must never be more than ₹0." Use H1\'s suggested_limit (it separates the segment from everyone else) unless a merchant\'s feedback (F) gives a different limit. Empty when propose is false.',
    '- hypothesis: one or two sentences on why this number drives shoppers away, with the abandonment figures. Cite H1, plus the F ids you followed and the R ids you compared against.',
    '- confidence: high when the link is direct and the gap large, medium otherwise, low when unsure.',
    '- assumptions: what you had to assume, at most five.',
    'Use only ids that appear in the input. Never invent ids, numbers, or limits.',
  ].join('\n'),
};

export interface AnalystContext {
  segment: Segment;
  suggestedLimit: number;
  revenue: RevenueAtRisk | null;
  catalog: ProbeCatalog;
  rules: readonly InvariantRule[];
  feedback: readonly RuleFeedback[];
  currency: string | null;
}

export interface AnalystEvidence {
  all: Set<string>;
  candidateId: string;
}

/** The analyst's user turn. Supplied ids = H1 + P + R + F. Numbers, names, selectors and notes only. */
export function churnAnalystInput(ctx: AnalystContext): { input: AgentInput; evidence: AnalystEvidence } {
  const s = ctx.segment;
  const f = s.feature;
  // The probes on the candidate's page, plus the candidate itself when it is a probe: enough to compare.
  const probes = ctx.catalog.probes.filter((p) => p.name === f.name || (f.route !== null && p.routes.includes(f.route))).slice(0, 20);
  const probeIds = probes.map((_, i) => `P${i + 1}`);
  const ruleIds = ctx.rules.map((_, i) => `R${i + 1}`);
  const feedbackIds = ctx.feedback.map((_, i) => `F${i + 1}`);
  const payload = {
    churn_reasons: CHURN_REASONS,
    currency: ctx.currency,
    evidence: [
      {
        id: 'H1',
        kind: 'candidate',
        number: { name: f.name, source: f.source, selector: f.selector, page: f.route, unit: f.unit },
        direction: s.direction === 'gte' ? 'at or above the threshold' : 'at or below the threshold',
        threshold: s.threshold,
        suggested_limit: ctx.suggestedLimit,
        segment: { sessions: s.segment.sessions, abandonment: round(s.segment.abandonment) },
        others: { sessions: s.baseline.sessions, abandonment: round(s.baseline.abandonment) },
        p_value: s.p < 1e-6 ? '< 0.000001' : Number(s.p.toPrecision(2)),
        values: s.values,
        revenue_at_risk: ctx.revenue ? { status: ctx.revenue.status, minor_units: ctx.revenue.revenue_at_risk_minor, currency: ctx.revenue.currency } : null,
      },
      ...probes.map((p, i) => ({ id: probeIds[i]!, kind: 'probe', name: p.name, source: p.source, min: p.min, median: p.median, max: p.max, routes: p.routes })),
      ...ctx.rules.map((r, i) => ({ id: ruleIds[i]!, kind: 'rule', rule_id: r.id, title: r.title, rule: ruleText(r) })),
      ...ctx.feedback.map((x, i) => ({ id: feedbackIds[i]!, kind: 'feedback', verdict: x.verdict, title: x.title, churn_reason: x.churn_reason, note: x.note })),
    ],
  };
  const text = `Judge this candidate: does it plausibly drive shoppers away, and what rule would catch it?\n\n${INPUT_MARKER}\n${JSON.stringify(payload, null, 1)}`;
  return { input: { text }, evidence: { all: new Set(['H1', ...probeIds, ...ruleIds, ...feedbackIds]), candidateId: 'H1' } };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Grounded and usable: citations known and H1 among them; a proposal has a sentence naming its probe, and a
 * discovered number gets a valid, free probe name; a decline carries neither.
 */
export function validateChurnAnalyst(out: ChurnAnalystOutput, ctx: { supplied: ReadonlySet<string>; segment: Segment; takenNames: ReadonlySet<string> }): string[] {
  const errors = citationErrors(out, ctx.supplied);
  if (!out.hypothesis.evidence_ids.includes('H1')) errors.push('hypothesis.evidence_ids must cite the candidate H1');
  const discovered = ctx.segment.feature.source === 'discovered';
  const sentence = out.sentence.trim();
  if (!out.propose) {
    if (sentence !== '') errors.push('sentence must be an empty string when propose is false');
    return errors;
  }
  if (sentence.length < SENTENCE_LIMITS.min || sentence.length > SENTENCE_LIMITS.max) errors.push(`sentence must be ${SENTENCE_LIMITS.min} to ${SENTENCE_LIMITS.max} characters when propose is true`);
  const name = discovered ? out.probe_name.trim() : ctx.segment.feature.name;
  if (discovered) {
    if (!PROBE_NAME.test(name)) errors.push('probe_name must be snake_case (lowercase letters, digits and _, starting with a letter) for a discovered number');
    else if (name.startsWith(REQUEST_PROBE_PREFIX)) errors.push(`probe_name must not start with ${REQUEST_PROBE_PREFIX} (reserved for request probes)`);
    else if (ctx.takenNames.has(name)) errors.push(`probe_name ${name} is already a probe; pick another name`);
  } else if (out.probe_name.trim() !== '') errors.push('probe_name must be empty: H1 is already a probe');
  if (PROBE_NAME.test(name) && !new RegExp(`(^|[^a-z0-9_])${name}([^a-z0-9_]|$)`, 'i').test(sentence)) errors.push(`the sentence must name the probe exactly: ${name}`);
  return errors;
}
