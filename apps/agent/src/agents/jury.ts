import { JudgeOutput, JurorOutput, type EvidenceItem, type JurorRole, type RevenueAtRisk, type RootCauseOutput, type TriageOutput, type RankOutput } from '@cp/schema';
import { forModel } from '../evidence.js';
import type { AgentInput, AgentSpec } from '../llm/run-agent.js';
import { COMMON, INPUT_MARKER } from './prompts.js';

/**
 * The jury (ARCHITECTURE.md section 5): independent reviewers who each score one finished AI report, and a
 * judge who writes the ruling in words. The decision itself is taken by code in `jury/verdict.ts`, so no
 * juror and no judge can approve a report that the numbers do not. Bump JURY_PROMPT_VERSION on any change
 * here: it is part of the verdict's cache key.
 */
export const JURY_PROMPT_VERSION = 'j1.1';

const JUROR_COMMON = [
  COMMON,
  '',
  'You are one juror reviewing a finished report about one issue. Other jurors review it separately; you never see their answers.',
  '- score: 0 to 1, how far the report deserves to be trusted for YOUR question below (1 = fully, 0.5 = doubtful, 0 = wrong). Use the whole range; do not default to a high number.',
  '- rationale: one or two sentences saying why, citing the evidence ids that show it.',
].join('\n');

/** What each juror is asked. Order matters: JURY_SIZE takes the first n. */
export const JUROR_QUESTIONS: Record<JurorRole, string> = {
  evidence_auditor:
    'Your question: does every claim in the report really rest on the evidence items it cites? Check the cited items one by one. Penalise a claim that says more than its evidence shows, a number that is not in the evidence, or a citation that does not support the sentence.',
  skeptic:
    'Your question: is this a real defect, or could it be normal shopper behaviour, noise or a coincidence? Argue the false-positive case first, then score. Give a high score only when the evidence rules the innocent explanations out.',
  impact_analyst:
    'Your question: are the impact numbers (sessions affected, revenue at risk) and the priority tier sensible for what the evidence shows? Penalise an inflated or unsupported impact, and a tier that is far too high or too low for the damage described.',
  repro_reviewer:
    'Your question: could an engineer who has never seen this issue reproduce it from the repro steps and find the cause from the hypothesis and the suggested fix area? Penalise vague steps, missing steps, and a fix area that does not match the evidence.',
};

export function jurorSpec(role: JurorRole): AgentSpec<typeof JurorOutput> {
  return { name: 'juror', schema: JurorOutput, instruction: [JUROR_COMMON, '', JUROR_QUESTIONS[role]].join('\n') };
}

export const JUDGE: AgentSpec<typeof JudgeOutput> = {
  name: 'judge',
  schema: JudgeOutput,
  instruction: [
    COMMON,
    '',
    'You are the judge. Four independent jurors scored a report; code has already applied the rule and made the decision, which is in the input as "decision". You cannot change it.',
    '- ruling: one or two plain sentences telling a merchant what was decided and why, using the jurors\' strongest points and any doubts. If the decision is "rejected", say what a person should check first. Never contradict the decision.',
    `- "checks" are code checks: agents_ok false means one of the AI steps that wrote the report failed its own validation, so the report is unreliable and should be regenerated (the evidence itself may be fine); visual_ok false means the screenshot contradicted the report. When the jurors' scores are high but a check failed, say exactly that, in those words, and do not blame the evidence.`,
    'Cite the evidence ids the jurors cited (only ids that appear in the input).',
  ].join('\n'),
};

/** What jurors see: the report in full, plus the evidence it rests on. */
export interface Report {
  title: string;
  tier: string;
  affected_sessions: number;
  revenue: Pick<RevenueAtRisk, 'status' | 'revenue_at_risk_minor' | 'currency' | 'note'>;
  triage: TriageOutput | null;
  root_cause: RootCauseOutput | null;
  ranker: RankOutput | null;
}

function turn(task: string, payload: unknown): string {
  return `${task}\n\n${INPUT_MARKER}\n${JSON.stringify(payload, null, 1)}`;
}

export function jurorInput(role: JurorRole, report: Report, evidence: readonly EvidenceItem[]): AgentInput {
  return { text: turn('Review this report and score it.', { role, report, evidence: forModel(evidence) }) };
}

export interface JudgeFacts {
  decision: 'approved' | 'rejected';
  mean_score: number;
  threshold: number;
  checks: { agents_ok: boolean; visual_ok: boolean };
  jurors: { role: JurorRole; score: number; rationale: string }[];
}

export function judgeInput(facts: JudgeFacts, evidence: readonly EvidenceItem[]): AgentInput {
  return { text: turn('Write the ruling.', { ...facts, evidence: forModel(evidence) }) };
}
