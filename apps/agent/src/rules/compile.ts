import { InvariantRuleSchema, RULE_ID, type Expr, type InvariantRule, type RuleAuthorOutput, type RuleTerm } from '@cp/schema';
import { unknownCitations } from '../grounding.js';

/**
 * The rule author answers in a flat linear form (sum of coef x term per side) so Gemini's response
 * schema has no recursion. Code turns it into the detectors' `Expr` here, and the validator below
 * checks every probe, route, and citation against what we supplied before anything is compiled.
 */

const MAX_TOLERANCE = 1_000_000;

function termExpr(t: RuleTerm): Expr {
  if (t.kind === 'const') return { const: t.coef * t.value };
  const base: Expr =
    t.kind === 'sum'
      ? { sum: t.probe }
      : t.kind === 'count'
        ? { count: t.probe }
        : { probe: t.probe, ...(t.index > 0 ? { index: t.index } : {}), ...(t.default_zero ? { default: 0 } : {}) };
  return t.coef === 1 ? base : { mul: [{ const: t.coef }, base] };
}

function sideExpr(terms: readonly RuleTerm[]): Expr {
  const parts = terms.map(termExpr);
  return parts.length === 1 ? parts[0]! : { add: parts };
}

/**
 * Compile a validated author output into an invariant rule. Tolerance is kept on `eq` (the detector
 * applies it there) and folded into the right-hand side for `lte` and `gte`, so the detector's own
 * semantics never change for authored rules.
 */
export function compileRule(out: RuleAuthorOutput, version: number): InvariantRule {
  const tol = Math.round(out.tolerance_minor);
  let right = sideExpr(out.right);
  if (out.op !== 'eq' && tol > 0) right = { add: [right, { const: out.op === 'lte' ? tol : -tol }] };
  const required = [...out.left, ...out.right].filter((t) => t.kind !== 'const' && !(t.kind === 'probe' && t.default_zero)).map((t) => t.probe);
  const firstProbe = [...out.left, ...out.right].find((t) => t.kind !== 'const')?.probe;
  return InvariantRuleSchema.parse({
    id: out.rule_id,
    version,
    title: out.title.trim(),
    ...(out.routes.length ? { routes: out.routes } : {}),
    requires: [...new Set(required.length ? required : [firstProbe!])],
    assert: { left: sideExpr(out.left), op: out.op, right, tolerance_minor: out.op === 'eq' ? tol : 0 },
    highlight_probe: out.highlight_probe || firstProbe,
  });
}

export interface AuthorContext {
  probes: ReadonlySet<string>;
  routes: ReadonlySet<string>;
  evidenceIds: ReadonlySet<string>;
  /** Built-in rule ids: an authored rule may not take one over. */
  reservedIds: ReadonlySet<string>;
}

/** Grounding and shape checks. A non-empty result rejects the answer (retried once, then fails closed). */
export function validateRuleAuthor(out: RuleAuthorOutput, ctx: AuthorContext): string[] {
  const errors: string[] = [];
  const unknown = unknownCitations(out, ctx.evidenceIds);
  if (unknown.length) errors.push(`cites evidence ids that were not supplied: ${unknown.join(', ')} (allowed: ${[...ctx.evidenceIds].join(', ')})`);
  if (!out.understood) return errors;

  if (!RULE_ID.test(out.rule_id)) errors.push('rule_id must be snake_case: a lowercase letter, then 1 to 63 lowercase letters, digits or underscores');
  if (ctx.reservedIds.has(out.rule_id)) errors.push(`rule_id ${out.rule_id} is a built-in rule; choose a new id`);
  if (out.title.trim().length < 3) errors.push('title is required');
  if (out.left.length === 0 || out.right.length === 0) errors.push('both sides need at least one term');
  const terms = [...out.left, ...out.right];
  if (!terms.some((t) => t.kind !== 'const')) errors.push('the rule must read at least one probe');
  terms.forEach((t, i) => {
    const at = `term ${i + 1}`;
    if (!Number.isFinite(t.coef) || t.coef === 0) errors.push(`${at}: coef must be a non-zero number`);
    if (t.kind === 'const') {
      if (!Number.isFinite(t.value)) errors.push(`${at}: value must be a number`);
      return;
    }
    if (!ctx.probes.has(t.probe)) errors.push(`${at}: probe "${t.probe}" does not exist (known probes: ${[...ctx.probes].join(', ')})`);
    if (!Number.isInteger(t.index) || t.index < 0 || t.index > 50) errors.push(`${at}: index must be an integer from 0 to 50`);
    if (t.default_zero && t.kind !== 'probe') errors.push(`${at}: default_zero only applies to kind probe`);
  });
  if (!Number.isInteger(out.tolerance_minor) || out.tolerance_minor < 0 || out.tolerance_minor > MAX_TOLERANCE) {
    errors.push(`tolerance_minor must be a whole number of minor units from 0 to ${MAX_TOLERANCE}`);
  }
  const badRoutes = out.routes.filter((r) => !ctx.routes.has(r));
  if (badRoutes.length) errors.push(`unknown routes: ${badRoutes.join(', ')} (known: ${[...ctx.routes].join(', ')}); use an empty list for everywhere`);
  if (out.highlight_probe && !ctx.probes.has(out.highlight_probe)) errors.push(`highlight_probe "${out.highlight_probe}" does not exist`);
  if (errors.length === 0) {
    try {
      compileRule(out, 1);
    } catch (err) {
      errors.push(`the rule does not compile: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    }
  }
  return errors;
}
