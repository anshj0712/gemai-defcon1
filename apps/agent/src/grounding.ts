import type { PriorityRule, RankOutput, RootCauseOutput, RuleSuggesterOutput, TriageOutput } from '@cp/schema';

/**
 * The grounding validator (AGENTS.md: "every LLM claim must cite evidence ids we supplied"). It runs
 * on every agent output after schema validation. A non-empty result rejects the output: the agent
 * is retried once with these messages, then fails closed.
 */

/** Length of a rule sentence, whoever writes it (a merchant, or the rule suggester). */
export const SENTENCE_LIMITS = { min: 8, max: 500 } as const;

/** Every `evidence_ids` array anywhere in an output, flattened. */
export function citedIds(output: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'evidence_ids' && Array.isArray(x)) out.push(...x.filter((i): i is string => typeof i === 'string'));
        else walk(x);
      }
    }
  };
  walk(output);
  return out;
}

export function unknownCitations(output: unknown, supplied: ReadonlySet<string>): string[] {
  return [...new Set(citedIds(output).filter((id) => !supplied.has(id)))];
}

export function citationErrors(output: unknown, supplied: ReadonlySet<string>): string[] {
  const unknown = unknownCitations(output, supplied);
  return unknown.length ? [`cites evidence ids that were not supplied: ${unknown.join(', ')} (allowed: ${[...supplied].join(', ')})`] : [];
}

export function validateTriage(out: TriageOutput, supplied: ReadonlySet<string>): string[] {
  const errors = citationErrors(out, supplied);
  if (!out.repro_steps.some((s) => s.evidence_ids.length > 0)) errors.push('at least one repro step must cite evidence');
  return errors;
}

export function validateRootCause(out: RootCauseOutput, supplied: ReadonlySet<string>, screenshotId: string | null): string[] {
  const errors = citationErrors(out, supplied);
  if (screenshotId === null && out.visual_check !== 'not_checked') errors.push('visual_check must be not_checked: no screenshot was supplied');
  if (screenshotId !== null && (out.visual_check === 'confirmed' || out.visual_check === 'not_confirmed') && !out.visual_notes.evidence_ids.includes(screenshotId)) {
    errors.push(`a visual verdict must cite the screenshot ${screenshotId} in visual_notes.evidence_ids`);
  }
  return errors;
}

export function validateRank(out: RankOutput, supplied: ReadonlySet<string>, rules: readonly PriorityRule[]): string[] {
  const errors = citationErrors(out, supplied);
  const known = new Set(rules.map((r) => r.id));
  const unknownRules = out.rule_ids.filter((id) => !known.has(id));
  if (unknownRules.length) errors.push(`cites priority rules that do not exist: ${unknownRules.join(', ')} (allowed: ${[...known].join(', ')})`);
  if (out.tier_move === 'none' && out.move_rule_id !== '') errors.push('move_rule_id must be empty when tier_move is none');
  if (out.tier_move !== 'none' && !out.rule_ids.includes(out.move_rule_id)) errors.push('a tier move must name one of the cited rule_ids in move_rule_id');
  return errors;
}

/**
 * The rule suggester: a proposal is one sentence of rule length whose explanation cites the probe
 * statistics it rests on (when any were supplied); a decline carries no sentence.
 */
export function validateRuleSuggestion(out: RuleSuggesterOutput, supplied: ReadonlySet<string>, probeIds: ReadonlySet<string>): string[] {
  const errors = citationErrors(out, supplied);
  const sentence = out.sentence.trim();
  if (out.propose) {
    if (sentence.length < SENTENCE_LIMITS.min || sentence.length > SENTENCE_LIMITS.max) {
      errors.push(`sentence must be one sentence of ${SENTENCE_LIMITS.min} to ${SENTENCE_LIMITS.max} characters when propose is true`);
    }
    if (probeIds.size === 0) errors.push('propose must be false: no probe statistics were supplied, so no rule could check this issue');
    else if (!out.explanation.evidence_ids.some((id) => probeIds.has(id))) {
      errors.push(`a proposal must cite the probe statistics it rests on (one of ${[...probeIds].join(', ')}) in explanation.evidence_ids`);
    }
  } else if (sentence !== '') {
    errors.push('sentence must be an empty string when propose is false');
  }
  return errors;
}
