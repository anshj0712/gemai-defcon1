import type { Expr, InvariantRule } from '@cp/schema';
import { routeTemplate } from './fingerprint.js';

/**
 * Built-in invariant rules. They run only where their probes exist, so a tenant opts in by
 * registering probes with these names. Phase 4 adds tenant rules (authored in plain English).
 */
export const BUILTIN_RULES: InvariantRule[] = [
  {
    id: 'cart_total_matches_lines',
    version: 1,
    title: "Cart total doesn't match its line items",
    requires: ['cart_total', 'line_total'],
    assert: {
      left: { probe: 'cart_total' },
      op: 'eq',
      right: { sub: [{ sum: 'line_total' }, { probe: 'discount', default: 0 }] },
      tolerance_minor: 1,
    },
    highlight_probe: 'cart_total',
  },
];

export type ProbeValues = Record<string, readonly number[]>;

/** Evaluate an expression over a probe snapshot; null when a referenced probe is missing. */
export function evaluate(expr: Expr, values: ProbeValues): number | null {
  if ('const' in expr) return expr.const;
  if ('probe' in expr) {
    const v = values[expr.probe]?.[expr.index ?? 0];
    return v ?? expr.default ?? null;
  }
  if ('sum' in expr) {
    const list = values[expr.sum];
    return list ? list.reduce((a, b) => a + b, 0) : null;
  }
  if ('count' in expr) return values[expr.count]?.length ?? null;
  if ('abs' in expr) {
    const v = evaluate(expr.abs, values);
    return v === null ? null : Math.abs(v);
  }
  if ('sub' in expr) {
    const [a, b] = expr.sub.map((e) => evaluate(e, values));
    return a === null || a === undefined || b === null || b === undefined ? null : a - b;
  }
  const parts = ('add' in expr ? expr.add : expr.mul).map((e) => evaluate(e, values));
  if (parts.some((p) => p === null)) return null;
  return 'add' in expr ? (parts as number[]).reduce((a, b) => a + b, 0) : (parts as number[]).reduce((a, b) => a * b, 1);
}

export interface RuleCheck {
  /** False when the rule does not apply here (route, or a required probe is missing). */
  applicable: boolean;
  ok: boolean;
  left: number | null;
  right: number | null;
  delta: number | null;
}

/** Check one rule against one snapshot taken on `route`. Money is integer minor units throughout. */
export function checkRule(rule: InvariantRule, values: ProbeValues, route: string | null): RuleCheck {
  const na: RuleCheck = { applicable: false, ok: true, left: null, right: null, delta: null };
  if (rule.routes && rule.routes.length > 0 && !(route && rule.routes.includes(routeTemplate(route)))) return na;
  if (rule.requires.some((p) => !values[p] || values[p]!.length === 0)) return na;
  const left = evaluate(rule.assert.left, values);
  const right = evaluate(rule.assert.right, values);
  if (left === null || right === null) return na;
  const delta = left - right;
  const tolerance = rule.assert.tolerance_minor ?? 0;
  const ok = rule.assert.op === 'eq' ? Math.abs(delta) <= tolerance : rule.assert.op === 'lte' ? left <= right : left >= right;
  return { applicable: true, ok, left, right, delta };
}
