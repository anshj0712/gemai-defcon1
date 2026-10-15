import { z } from 'zod';
import { Claim } from './findings.js';

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

export const RULE_ID = /^[a-z][a-z0-9_]{1,63}$/;

/** `rule_id@version`: the rule version stamped on every signal the rule produces. */
export const ruleVersionOf = (rule: Pick<InvariantRule, 'id' | 'version'>) => `${rule.id}@${rule.version}`;

const OPS = { eq: '=', lte: '≤', gte: '≥' } as const;

function exprText(e: Expr): string {
  if ('const' in e) return e.const.toLocaleString('en-IN');
  if ('probe' in e) return `${e.probe}${e.index ? `[${e.index}]` : ''}`;
  if ('sum' in e) return `sum(${e.sum})`;
  if ('count' in e) return `count(${e.count})`;
  if ('abs' in e) return `|${exprText(e.abs)}|`;
  if ('sub' in e) return `${exprText(e.sub[0])} − ${wrap(e.sub[1])}`;
  if ('add' in e) {
    return e.add
      .map((p, i) => {
        const neg = negated(p);
        if (i === 0) return exprText(p);
        return neg ? ` − ${wrap(neg)}` : ` + ${exprText(p)}`;
      })
      .join('');
  }
  return e.mul.map(wrap).join(' × ');
}

/** `x` when the expression is `-1 × x` (how a subtracted term is compiled), else null. */
function negated(e: Expr): Expr | null {
  if (!('mul' in e) || e.mul.length !== 2) return null;
  const [c, x] = e.mul;
  return c && x && 'const' in c && c.const === -1 ? x : null;
}

const wrap = (e: Expr) => ('add' in e || 'sub' in e ? `(${exprText(e)})` : exprText(e));

/** One line a person can check, for example "cart_total = sum(line_total) − discount (within 1)". Money constants are minor units. */
export function ruleText(rule: Pick<InvariantRule, 'assert'>): string {
  const a = rule.assert;
  const tol = a.tolerance_minor ? ` (within ${a.tolerance_minor})` : '';
  return `${exprText(a.left)} ${OPS[a.op]} ${exprText(a.right)}${tol}`;
}

// ---------------------------------------------------------------------------------------------
// Phase 4: rules written in plain English, a dry run, human approval, and a retroactive re-scan.
// ---------------------------------------------------------------------------------------------

/**
 * One term of the rule author's linear form: coef x (a probe value, the sum or count of a probe, or a
 * constant). Flat on purpose: Gemini's response schema gets no recursion, and code compiles the terms
 * into an `Expr` (ARCHITECTURE.md section 6).
 */
export const RuleTerm = z.object({
  coef: z.number(),
  kind: z.enum(['probe', 'sum', 'count', 'const']),
  /** Probe name; empty for const. */
  probe: z.string().max(64),
  /** Which value of a multi-value probe (kind probe); 0 is the first. */
  index: z.number(),
  /** The constant (kind const); money is in minor units. 0 for other kinds. */
  value: z.number(),
  /** Read a missing probe as 0 instead of skipping the snapshot. */
  default_zero: z.boolean(),
});
export type RuleTerm = z.infer<typeof RuleTerm>;

/** What the rule author returns for one merchant sentence. `understood` false means it cannot be expressed over the probes. */
export const RuleAuthorOutput = z.object({
  understood: z.boolean(),
  rule_id: z.string().max(64),
  title: z.string().max(120),
  left: z.array(RuleTerm).max(6),
  op: z.enum(['eq', 'lte', 'gte']),
  right: z.array(RuleTerm).max(6),
  tolerance_minor: z.number(),
  /** Route templates the rule is limited to; empty means everywhere the probes exist. */
  routes: z.array(z.string().max(256)).max(10),
  highlight_probe: z.string().max(64),
  /** How the sentence maps to probes, citing the input ids (S1 sentence, P probes, R rules). */
  explanation: Claim,
  assumptions: z.array(z.string().max(200)).max(5),
});
export type RuleAuthorOutput = z.infer<typeof RuleAuthorOutput>;

export interface RuleAuthorMeta {
  model: string;
  prompt_hash: string;
  /** True when the offline stand-in wrote the draft, not Gemini. */
  offline: boolean;
  explanation: string;
  evidence_ids: string[];
  assumptions: string[];
  attempts: number;
  ms: number;
}

/** One session the draft would flag. No session content: ids, times, and the two sides of the rule. */
export interface DryRunSample {
  session_id: string;
  seq: number;
  event_time: number;
  route: string;
  left: number | null;
  right: number | null;
  delta: number | null;
  currency: string | null;
  /** Already in an issue found by another rule or detector. */
  in_issue: boolean;
}

/** What a draft would flag over recent sessions. Nothing is written. */
export interface DryRun {
  rule_version: string;
  window: { from: number; to: number };
  sessions_scanned: number;
  /** Sessions with at least one probe snapshot the rule applies to. */
  sessions_applicable: number;
  sessions_hit: number;
  snapshots_checked: number;
  /** sessions_hit / sessions_applicable; null when nothing applied. */
  hit_rate: number | null;
  hits_in_issues: number;
  samples: DryRunSample[];
  /** The window held more sessions than the dry run reads. */
  truncated: boolean;
  ms: number;
  at: number;
}

export const RESCAN_STATES = ['running', 'done', 'failed', 'interrupted'] as const;
export type RescanState = (typeof RESCAN_STATES)[number];

export interface RescanStatus {
  rescan_id: string;
  rule_version: string;
  status: RescanState;
  /** Valid-time window re-scanned. */
  window: { from: number; to: number };
  started_at: number;
  finished_at: number | null;
  sessions_total: number;
  sessions_scanned: number;
  sessions_failed: number;
  chunks_scanned: number;
  sessions_hit: number;
  signals_written: number;
  /** More sessions in the window than RESCAN_MAX_SESSIONS. */
  truncated: boolean;
  error: string | null;
}

export interface RuleDraft {
  rule: InvariantRule;
  sentence: string;
  author: RuleAuthorMeta;
  dry_run: DryRun | null;
  created_at: number;
}

export interface ActiveRule {
  rule: InvariantRule;
  sentence: string;
  author: RuleAuthorMeta | null;
  approved_at: number;
  approved_by: string;
}

/**
 * Hot copy of one tenant rule (Firestore `rules`): the approved version the processor runs, a pending
 * draft, and the latest re-scan. Written by the agent service only. The bitemporal record is the
 * `rules` table, which gets one row per approved version.
 */
export interface RuleDoc {
  v: 1;
  tenant_id: string;
  rule_id: string;
  title: string;
  active: ActiveRule | null;
  draft: RuleDraft | null;
  rescan: RescanStatus | null;
  /** Approved versions, oldest first. */
  versions: { version: number; approved_at: number }[];
  created_at: number;
  updated_at: number;
  synthetic: true;
}
