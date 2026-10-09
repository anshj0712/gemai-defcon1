import { RankOutput, RootCauseOutput, TriageOutput, type EvidenceItem, type PriorityRule, type RevenueAtRisk } from '@cp/schema';
import { forModel } from '../evidence.js';
import type { AgentInput, AgentSpec } from '../llm/run-agent.js';

/**
 * The three agents of the finding pipeline. Each has one job, a JSON output schema, and a prompt
 * that requires every claim to cite evidence ids from its input (ARCHITECTURE.md section 5).
 * Bump PROMPT_VERSION on any prompt or schema change: it is part of the cache key, so cached
 * outputs from older prompts are re-generated.
 */
export const PROMPT_VERSION = 'p3.1';

/** Marker line before the JSON payload in every user turn (the offline stand-in reads it too). */
export const INPUT_MARKER = 'INPUT_JSON:';

const COMMON = [
  'You work for a checkout monitoring service that finds bugs in an online store from recorded, privacy-masked shopper sessions.',
  'You receive structured evidence only: detector facts, CSS selectors, normalized error signatures, numbers, and sometimes one masked screenshot. You never see raw page HTML or recordings.',
  'Ground every statement in the evidence. Each claim lists the ids of the evidence items it rests on in evidence_ids, using only ids that appear in the input (for example E1, E3). Never invent ids, numbers, code, file names, or causes the evidence does not support; say what is uncertain instead.',
  'All sessions and amounts are synthetic demo data. Write for a merchant and their engineers: short, concrete, plain English.',
  'Reply with JSON only, matching the response schema.',
].join('\n');

export const TRIAGE: AgentSpec<typeof TriageOutput> = {
  name: 'triage',
  schema: TriageOutput,
  instruction: [
    COMMON,
    '',
    'Your job: triage one issue (a cluster of detector signals that point at the same broken thing).',
    '- title: a merchant-facing title of at most 90 characters naming the control or rule and the route.',
    '- category: checkout_blocker (stops ordering or paying), pricing_error (wrong price or total), broken_control (a control that ignores or fails clicks), error_spike (errors without a clear blocked step), or other.',
    '- confidence: 0 to 1, how sure you are that this is a real defect rather than shopper behaviour.',
    '- summary: one or two sentences on what shoppers experience and the impact.',
    '- likely_cause: the most likely cause, hedged when the evidence is thin.',
    '- repro_steps: 2 to 8 steps an engineer can follow in the store to reproduce it; cite the evidence each step relies on.',
  ].join('\n'),
};

export const ROOT_CAUSE: AgentSpec<typeof RootCauseOutput> = {
  name: 'root_cause',
  schema: RootCauseOutput,
  instruction: [
    COMMON,
    '',
    'Your job: form a root-cause hypothesis for one triaged issue and verify it visually.',
    '- hypothesis: the most likely technical cause (which handler, calculation, or request fails, and when), citing evidence.',
    '- visual_check: if a screenshot item is in the evidence and the image is attached, look at it. The flagged element is outlined in red; masked text appears as asterisks or blocks. Answer confirmed when the image shows the defect (for example a total that does not match the line items, or a control in a state consistent with the signal), not_confirmed when the image contradicts it, unclear when the image cannot tell. Answer not_checked when there is no screenshot.',
    '- visual_notes: what you saw and why it supports your verdict; cite the screenshot id for confirmed or not_confirmed.',
    '- suggested_fix_area: where an engineer should look first, in one line.',
  ].join('\n'),
};

export const RANKER: AgentSpec<typeof RankOutput> = {
  name: 'ranker',
  schema: RankOutput,
  instruction: [
    COMMON,
    '',
    'Your job: classify one finding into the priority rule set. Code has already computed its base tier and revenue at risk; you cannot change the score.',
    '- rule_ids: the ids of the priority rules that apply, most important first. Use only ids from the rule set in the input.',
    '- tier_move: none in most cases. Propose up (more urgent) or down (less urgent) only when a rule in the set clearly describes this finding better than the base tier does. A move is at most one tier and is checked by code.',
    '- move_rule_id: the rule id that justifies the move, or an empty string when tier_move is none.',
    '- reason: one or two sentences, citing evidence.',
  ].join('\n'),
};

function turn(task: string, payload: unknown): string {
  return `${task}\n\n${INPUT_MARKER}\n${JSON.stringify(payload, null, 1)}`;
}

export function triageInput(evidence: readonly EvidenceItem[]): AgentInput {
  return { text: turn('Triage this issue.', { evidence: forModel(evidence) }) };
}

export function rootCauseInput(evidence: readonly EvidenceItem[], triage: TriageOutput | null, image: Buffer | null): AgentInput {
  return {
    text: turn(image ? 'Form a root-cause hypothesis. The screenshot item refers to the attached image.' : 'Form a root-cause hypothesis. No screenshot is available.', {
      triage,
      evidence: forModel(evidence),
    }),
    ...(image ? { image: { mimeType: 'image/png' as const, data: image } } : {}),
  };
}

export function rankerInput(
  evidence: readonly EvidenceItem[],
  facts: { base_tier: string; base_rule_ids: string[]; revenue: RevenueAtRisk; triage: TriageOutput | null },
  rules: readonly PriorityRule[],
): AgentInput {
  return {
    text: turn('Classify this finding into the priority rule set.', {
      base_tier: facts.base_tier,
      base_rule_ids: facts.base_rule_ids,
      triage: facts.triage ? { title: facts.triage.title, category: facts.triage.category, summary: facts.triage.summary.text } : null,
      revenue_at_risk: { status: facts.revenue.status, minor_units: facts.revenue.revenue_at_risk_minor, currency: facts.revenue.currency },
      rule_set: rules.map((r) => ({ id: r.id, tier: r.tier, title: r.title, description: r.description })),
      evidence: forModel(evidence),
    }),
  };
}
