import { createHash } from 'node:crypto';
import type { Logger } from '@cp/logger';
import { JUROR_ROLES, type EvidenceItem, type FindingVerdict, type JurorRole, type JurorScore } from '@cp/schema';
import { judgeInput, JUDGE, jurorInput, jurorSpec, JURY_PROMPT_VERSION, type Report } from './agents/jury.js';
import { citationErrors } from './grounding.js';
import type { ModelSet } from './llm/models.js';
import { runStructured, type RunOptions } from './llm/run-agent.js';

/**
 * The jury's gate. Code decides; the judge only writes the words.
 *   approved     mean score of the jurors who answered is above the threshold, enough of them answered,
 *                and the deterministic checks (agents answered, screenshot did not contradict) hold
 *   rejected     enough jurors answered, but the mean is at or under the threshold or a check failed
 *   unavailable  too few jurors answered (model down): no verdict either way, the report is left as it was
 */
export interface JuryParams {
  /** How many jurors sit (1 to 4, the first n of JUROR_ROLES). */
  size: number;
  /** Approve only above this mean (0 to 1). */
  threshold: number;
}

/** With four or more jurors one may fail to answer; with fewer, all must. */
export const jurorsNeeded = (size: number): number => (size >= 4 ? size - 1 : size);

export interface GateInput {
  scores: readonly (number | null)[];
  asked: number;
  params: JuryParams;
  checks: { agents_ok: boolean; visual_ok: boolean };
}

export interface Gate {
  outcome: FindingVerdict['outcome'];
  mean: number | null;
  answered: number;
  needed: number;
}

export function gate(g: GateInput): Gate {
  const answers = g.scores.filter((s): s is number => s !== null);
  const needed = jurorsNeeded(g.asked);
  if (answers.length < needed) return { outcome: 'unavailable', mean: null, answered: answers.length, needed };
  const mean = Math.round((answers.reduce((a, b) => a + b, 0) / answers.length) * 1000) / 1000;
  const ok = mean > g.params.threshold && g.checks.agents_ok && g.checks.visual_ok;
  return { outcome: ok ? 'approved' : 'rejected', mean, answered: answers.length, needed };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The decision in one plain sentence, written by code. */
export function summaryLine(g: Gate, params: JuryParams, checks: GateInput['checks']): string {
  if (g.outcome === 'unavailable') return `Not reviewed: only ${g.answered} of ${g.needed} needed jurors answered.`;
  if (g.outcome === 'approved') return `Approved: the jurors averaged ${pct(g.mean!)}, above the ${pct(params.threshold)} bar.`;
  if (!checks.agents_ok) return `Held back: one of the AI steps failed its own checks, whatever the jurors said (they averaged ${pct(g.mean!)}).`;
  if (!checks.visual_ok) return `Held back: the screenshot did not show the defect (the jurors averaged ${pct(g.mean!)}).`;
  return `Held back: the jurors averaged ${pct(g.mean!)}, not above the ${pct(params.threshold)} bar.`;
}

export interface JuryDeps {
  models: ModelSet;
  params: JuryParams;
  runOptions?: RunOptions;
  logger: Logger;
  now?: () => number;
}

export interface JuryInput {
  report: Report;
  evidence: readonly EvidenceItem[];
  checks: { agents_ok: boolean; visual_ok: boolean };
  /** Cache key of what the verdict is computed from. */
  key: string;
}

/** The key under which a verdict is reused: the finding's own key plus everything about the jury. */
export function juryKey(llmKey: string, deps: Pick<JuryDeps, 'models' | 'params'>): string {
  return createHash('sha256')
    .update(JSON.stringify([llmKey, JURY_PROMPT_VERSION, deps.params, deps.models.bulk.model, deps.models.offline]))
    .digest('hex')
    .slice(0, 20);
}

/** Convene the jury: the jurors answer in parallel, code applies the gate, then the judge writes the ruling. Never throws. */
export async function convene(deps: JuryDeps, input: JuryInput): Promise<FindingVerdict> {
  const now = deps.now ?? Date.now;
  const ids = new Set(input.evidence.map((e) => e.id));
  const roles: JurorRole[] = JUROR_ROLES.slice(0, Math.max(1, Math.min(JUROR_ROLES.length, deps.params.size)));

  const jurors: JurorScore[] = await Promise.all(
    roles.map(async (role): Promise<JurorScore> => {
      const r = await runStructured(jurorSpec(role), deps.models.bulk, jurorInput(role, input.report, input.evidence), (o) => citationErrors(o, ids), deps.runOptions);
      return { role, score: r.output?.score ?? null, rationale: r.output?.rationale ?? null, model: r.run.model, prompt_hash: r.run.prompt_hash, ok: r.run.ok };
    }),
  );

  const g = gate({ scores: jurors.map((j) => j.score), asked: roles.length, params: deps.params, checks: input.checks });
  let ruling: FindingVerdict['ruling'] = null;
  let judgeModel: string | null = null;
  if (g.outcome !== 'unavailable') {
    const answered = jurors.filter((j) => j.score !== null && j.rationale !== null);
    const j = await runStructured(
      JUDGE,
      deps.models.bulk,
      judgeInput(
        {
          decision: g.outcome,
          mean_score: g.mean!,
          threshold: deps.params.threshold,
          checks: input.checks,
          jurors: answered.map((x) => ({ role: x.role, score: x.score!, rationale: x.rationale!.text })),
        },
        input.evidence,
      ),
      (o) => citationErrors(o, ids),
      deps.runOptions,
    );
    ruling = j.output?.ruling ?? null;
    judgeModel = j.run.model;
  }
  const failed = jurors.filter((j) => !j.ok).length;
  if (failed > 0) deps.logger.warn({ failed, asked: roles.length }, 'some jurors could not answer');
  return {
    outcome: g.outcome,
    mean_score: g.mean,
    threshold: deps.params.threshold,
    jurors_asked: roles.length,
    jurors_answered: g.answered,
    jurors_needed: g.needed,
    checks: input.checks,
    jurors,
    ruling,
    judge_model: judgeModel,
    summary: summaryLine(g, deps.params, input.checks),
    offline: deps.models.offline,
    key: input.key,
    at: now(),
  };
}
