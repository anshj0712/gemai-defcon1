import type { EvidenceItem, JurorScore, RankOutput, RevenueAtRisk, RootCauseOutput, Tier, TriageOutput } from '@cp/schema';

/**
 * The eval engine's scorer (pure: no model, no I/O). A golden case is a real evidence pack the agents were given for
 * one planted bug, with what a correct answer must mention. The runner asks the agents again and this file scores the
 * answers. The checks are deliberately about substance (does the report name the broken thing, in a sensible
 * category, with a place to look), not wording, so a better phrasing still passes.
 */

export interface GoldenCase {
  v: 1;
  id: string;
  /** The planted bug this pack came from (docs/DEMO_BUGS.md). */
  bug: string;
  /** The pack exactly as the agents saw it (already masked, structured evidence). */
  evidence: EvidenceItem[];
  base_tier: Tier;
  base_rule_ids: string[];
  revenue: RevenueAtRisk;
  affected_sessions: number;
  expect: {
    /** Every group must match at least one phrase somewhere in the title, summary, cause or repro steps. */
    cause: string[][];
    /** The triage category must be one of these. */
    categories: string[];
    /** The suggested fix area must mention at least one of these. */
    where: string[];
  };
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const lower = (s: string) => s.toLowerCase();
const mentions = (text: string, phrases: readonly string[]) => phrases.some((p) => text.includes(lower(p)));

export function triageText(t: TriageOutput): string {
  return lower([t.title, t.summary.text, t.likely_cause.text, ...t.repro_steps.map((s) => s.step)].join(' \n '));
}

export function scoreTriage(c: GoldenCase, out: TriageOutput | null): CheckResult[] {
  if (!out) return [{ name: 'triage_valid', pass: false, detail: 'no valid answer (schema or evidence-id check failed, even after the retry)' }];
  const text = triageText(out);
  const missing = c.expect.cause.filter((group) => !mentions(text, group));
  return [
    { name: 'triage_valid', pass: true, detail: 'schema and evidence ids passed' },
    { name: 'names_the_defect', pass: missing.length === 0, detail: missing.length ? `missing one of: ${missing.map((g) => g.join(' / ')).join(' and ')}` : 'mentions the broken thing' },
    { name: 'category', pass: c.expect.categories.includes(out.category), detail: `${out.category}, expected ${c.expect.categories.join(' or ')}` },
    { name: 'repro_steps', pass: out.repro_steps.length >= 2 && out.repro_steps.every((s) => s.evidence_ids.length > 0), detail: `${out.repro_steps.length} steps, each citing evidence` },
  ];
}

export function scoreRootCause(c: GoldenCase, out: RootCauseOutput | null): CheckResult[] {
  if (!out) return [{ name: 'root_cause_valid', pass: false, detail: 'no valid answer' }];
  const where = lower(`${out.suggested_fix_area} ${out.hypothesis.text}`);
  return [
    { name: 'root_cause_valid', pass: true, detail: 'schema and evidence ids passed' },
    { name: 'where_to_look', pass: mentions(where, c.expect.where), detail: `"${out.suggested_fix_area}"` },
  ];
}

export function scoreRanker(out: RankOutput | null): CheckResult[] {
  return [{ name: 'ranker_valid', pass: out !== null, detail: out ? `${out.tier_move}, rules ${out.rule_ids.join(', ')}` : 'no valid answer' }];
}

export function scoreJury(outcome: 'approved' | 'rejected' | 'unavailable' | null, mean: number | null): CheckResult[] {
  if (outcome === null) return [];
  return [{ name: 'jury_approves', pass: outcome === 'approved', detail: `${outcome}${mean === null ? '' : ` at ${Math.round(mean * 100)}%`}` }];
}

export interface CaseResult {
  id: string;
  bug: string;
  checks: CheckResult[];
  pass: boolean;
  ms: number;
  calls: number;
  jurors?: Pick<JurorScore, 'role' | 'score'>[];
  title: string | null;
}

export interface EvalReport {
  at: number;
  offline: boolean;
  models: { bulk: string; reasoning: string };
  prompt_version: string;
  threshold: number;
  cases: CaseResult[];
  pass_rate: number;
  /** Per check: how many cases passed it. */
  checks: Record<string, { passed: number; total: number }>;
  mean_ms: number;
  pass: boolean;
}

export function summarize(cases: readonly CaseResult[], meta: Pick<EvalReport, 'at' | 'offline' | 'models' | 'prompt_version' | 'threshold'>): EvalReport {
  const checks: EvalReport['checks'] = {};
  for (const c of cases) {
    for (const k of c.checks) {
      const e = (checks[k.name] ??= { passed: 0, total: 0 });
      e.total += 1;
      if (k.pass) e.passed += 1;
    }
  }
  const passed = cases.filter((c) => c.pass).length;
  const pass_rate = cases.length ? passed / cases.length : 0;
  return {
    ...meta,
    cases: [...cases],
    pass_rate,
    checks,
    mean_ms: cases.length ? Math.round(cases.reduce((n, c) => n + c.ms, 0) / cases.length) : 0,
    pass: cases.length > 0 && pass_rate >= meta.threshold,
  };
}
