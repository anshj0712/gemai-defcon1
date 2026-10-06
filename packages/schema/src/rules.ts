import { z } from 'zod';

/**
 * Invariant rules: declarative checks over probe values (ARCHITECTURE.md section 4). Rules are data,
 * so the Phase 4 rule author can generate them and re-scans can replay them over stored probes.
 * All money is integer minor units.
 */

export type Expr =
  | { probe: string; index?: number; default?: number }
  | { sum: string }
  | { count: string }
  | { const: number }
  | { add: Expr[] }
  | { sub: [Expr, Expr] }
  | { mul: Expr[] }
  | { abs: Expr };

const probeName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

export const ExprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.object({ probe: probeName, index: z.int().min(0).optional(), default: z.number().optional() }),
    z.object({ sum: probeName }),
    z.object({ count: probeName }),
    z.object({ const: z.number() }),
    z.object({ add: z.array(ExprSchema).min(1).max(20) }),
    z.object({ sub: z.tuple([ExprSchema, ExprSchema]) }),
    z.object({ mul: z.array(ExprSchema).min(1).max(20) }),
    z.object({ abs: ExprSchema }),
  ]),
);

export const InvariantRuleSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  version: z.int().min(1),
  /** Shown in issue titles, for example "Cart total doesn't match its line items". */
  title: z.string().min(1).max(120),
  /** Route templates where the rule applies; omitted means everywhere. */
  routes: z.array(z.string().max(512)).max(50).optional(),
  /** Probes that must be present in the snapshot for the rule to be evaluated. */
  requires: z.array(probeName).min(1).max(20),
  assert: z.object({
    left: ExprSchema,
    op: z.enum(['eq', 'lte', 'gte']),
    right: ExprSchema,
    /** Allowed difference for `eq`, in minor units. */
    tolerance_minor: z.number().nonnegative().default(0),
  }),
  /** Probe whose element the replay outlines when the rule fires (usually the left-hand side). */
  highlight_probe: probeName.optional(),
});
export type InvariantRule = z.infer<typeof InvariantRuleSchema>;
