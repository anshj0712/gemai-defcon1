import { z } from 'zod';
import type { ClusterKind } from './clusters.js';

/**
 * Findings (Phase 3): a cluster scored by revenue at risk, ranked against the priority rule set, and
 * explained by the agent layer. Deterministic code decides the finding, its tier and its score; the
 * LLM outputs below explain, verify visually, and may move the tier by at most one step with a cited
 * priority rule (AGENTS.md rule 1). Every LLM claim cites evidence ids that we supplied.
 */

export const TIERS = ['P0', 'P1', 'P2', 'P3'] as const;
export type Tier = (typeof TIERS)[number];

// ---------------------------------------------------------------------------------------------
// Priority rule set: versioned data (stored in the `rules` table, kind builtin, type priority).
// ---------------------------------------------------------------------------------------------

export const PriorityRuleSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  version: z.int().min(1),
  /** The tier this bucket puts a finding in; null for modifiers (for example a release regression). */
  tier: z.enum(TIERS).nullable(),
  /** Score multiplier for modifiers; 1 for buckets. */
  multiplier: z.number().positive().default(1),
  title: z.string().min(1).max(120),
  /** What the bucket means, shown to the ranker agent. */
  description: z.string().min(1).max(400),
  /**
   * Deterministic matcher used for the base tier. Every listed condition must hold. Rules without a
   * matcher are only reachable through the ranker's bounded move.
   */
  match: z
    .object({
      kinds: z.array(z.enum(['element', 'invariant'])).optional(),
      /** Route prefixes, for example "/checkout". */
      route_prefixes: z.array(z.string().max(256)).max(20).optional(),
      /** The cluster has at least one JS error or failed request attached. */
      has_errors: z.boolean().optional(),
    })
    .optional(),
});
export type PriorityRule = z.infer<typeof PriorityRuleSchema>;

// ---------------------------------------------------------------------------------------------
// Agent outputs (structured JSON; zod is converted to the model's response schema by ADK).
// ---------------------------------------------------------------------------------------------

/** A statement and the evidence ids it rests on. */
export const Claim = z.object({
  text: z.string().min(1).max(600),
  evidence_ids: z.array(z.string().max(16)).min(1).max(12),
});
export type Claim = z.infer<typeof Claim>;

export const TRIAGE_CATEGORIES = ['checkout_blocker', 'pricing_error', 'broken_control', 'error_spike', 'other'] as const;

export const TriageOutput = z.object({
  /** Merchant-facing title, at most 100 characters. */
  title: z.string().min(3).max(100),
  category: z.enum(TRIAGE_CATEGORIES),
  confidence: z.number().min(0).max(1),
  /** One or two sentences: what shoppers experience. */
  summary: Claim,
  likely_cause: Claim,
  repro_steps: z
    .array(z.object({ step: z.string().min(1).max(200), evidence_ids: z.array(z.string().max(16)).max(6) }))
    .min(2)
    .max(8),
});
export type TriageOutput = z.infer<typeof TriageOutput>;

export const VISUAL_VERDICTS = ['confirmed', 'not_confirmed', 'unclear', 'not_checked'] as const;
export type VisualVerdict = (typeof VISUAL_VERDICTS)[number];

export const RootCauseOutput = z.object({
  hypothesis: Claim,
  /** Does the screenshot from the masked replay show the defect? not_checked when there is none. */
  visual_check: z.enum(VISUAL_VERDICTS),
  visual_notes: Claim,
  /** Where an engineer should look first (component, handler, or calculation). */
  suggested_fix_area: z.string().min(1).max(200),
});
export type RootCauseOutput = z.infer<typeof RootCauseOutput>;

export const RankOutput = z.object({
  /** Priority rule ids that apply to this finding. */
  rule_ids: z.array(z.string().max(64)).min(1).max(5),
  /** Proposed move from the deterministic base tier: up = more urgent. */
  tier_move: z.enum(['up', 'none', 'down']),
  /** The priority rule that justifies the move; empty when tier_move is none. */
  move_rule_id: z.string().max(64),
  reason: Claim,
});
export type RankOutput = z.infer<typeof RankOutput>;

// ---------------------------------------------------------------------------------------------
// The finding document (Firestore hot copy, API) and its evidence pack.
// ---------------------------------------------------------------------------------------------

export type EvidenceKind = 'issue' | 'signal' | 'error' | 'impact' | 'release' | 'screenshot';

/**
 * One item of structured evidence handed to the agents. No raw rrweb events, no HTML, no session
 * content: detector facts, selectors, normalized error signatures, numbers, and the masked screenshot.
 */
export interface EvidenceItem {
  /** Short id the LLM cites, for example "E3". */
  id: string;
  kind: EvidenceKind;
  text: string;
  signal_id?: string;
  session_id?: string;
  detector?: string;
  /** Valid time, epoch ms. */
  at?: number;
  data?: Record<string, string | number | boolean | null>;
}

export interface RevenueAtRisk {
  /** N_affected x V_cart x (a_affected - a_baseline), never negative. 0 when status is not ok. */
  revenue_at_risk_minor: number;
  currency: string | null;
  status: 'ok' | 'insufficient_data';
  /** Why the estimate is missing or weak, in plain words. */
  note: string | null;
  /** Weighted (1 / sample_rate) affected sessions that had a cart, scaled past the cluster's session list cap. */
  affected_with_cart: number;
  /** Affected sessions with a cart whose outcome is known (idle past the abandon window). */
  affected_decided: number;
  affected_abandoned: number;
  abandonment_affected: number | null;
  baseline_decided: number;
  baseline_abandoned: number;
  abandonment_baseline: number | null;
  /** route: unaffected sessions that visited the issue's route; all: every unaffected session (too few on the route). */
  baseline_scope: 'route' | 'all' | 'none';
  avg_cart_value_minor: number | null;
  /** Affected sessions with a cart still in progress (not counted in the rates yet). */
  pending: number;
}

export interface AgentRun {
  agent: 'triage' | 'root_cause' | 'ranker' | 'rule_author';
  model: string;
  prompt_hash: string;
  attempts: number;
  ok: boolean;
  /** Validator or model error when ok is false (no prompt or output text). */
  error: string | null;
  ms: number;
  at: number;
}

export interface FindingPriority {
  rule_set_version: string;
  /** Rules that matched deterministically; the first sets the base tier. */
  base_rule_ids: string[];
  base_tier: Tier;
  /** Rules the ranker agent cited (validated against the rule set). */
  cited_rule_ids: string[];
  /** Applied move: -1 = one tier more urgent, 1 = one tier less urgent. */
  tier_move: -1 | 0 | 1;
  move_rule_id: string | null;
  regression: boolean;
  multiplier: number;
}

export interface FindingScreenshot {
  evidence_id: string;
  signal_id: string;
  session_id: string;
  uri: string;
  /** Replay offset of the frame, ms from the session start. */
  offset_ms: number;
  captured_at: number;
}

export interface Finding {
  v: 1;
  tenant_id: string;
  /** Equal to the cluster id: one finding per issue, versioned over time. */
  finding_id: string;
  cluster_id: string;
  version: number;
  kind: ClusterKind;
  /** Agent title when available, else the deterministic cluster title. */
  title: string;
  cluster_title: string;
  route: string;
  anchor: string;
  /** suspect: the visual check did not show the defect, so a person should look first. */
  status: 'open' | 'suspect';
  tier: Tier;
  /** Ranking score: revenue at risk (major units) x tier weight x modifiers. Higher is more urgent. */
  score: number;
  priority: FindingPriority;
  revenue: RevenueAtRisk;
  triage: TriageOutput | null;
  root_cause: RootCauseOutput | null;
  ranker: RankOutput | null;
  evidence: EvidenceItem[];
  screenshot: FindingScreenshot | null;
  runs: AgentRun[];
  /** Inputs that decide whether the LLM steps re-run (symptoms, errors, releases, rule set, models). */
  llm_key: string;
  /** Everything that went into this version; a new version is written only when it changes. */
  input_hash: string;
  affected_sessions: number;
  signal_count: number;
  detectors: Record<string, number>;
  releases: string[];
  first_seen: number;
  last_seen: number;
  model_version: string;
  prompt_hash: string;
  rule_version: string;
  created_at: number;
  updated_at: number;
  /** Phase 4: whether a retroactive re-scan surfaced some of this issue's sessions (absent on older findings). */
  discovery?: FindingDiscovery;
  /** All demo data is synthetic (AGENTS.md rule 10). */
  synthetic: true;
}

/** Known at the time, or found later by re-scanning history with a newer rule. */
export interface FindingDiscovery {
  /** True when a re-scan added sessions: shoppers were hurt before the rule that flags them existed. */
  found_later: boolean;
  /** Sessions a re-scan added to the issue. */
  found_later_sessions: number;
  rescan_ids: string[];
}

/** Feed entry: the finding without its evidence pack and run log. */
export type FindingSummary = Omit<Finding, 'evidence' | 'runs'>;

const tierIndex = (t: Tier) => TIERS.indexOf(t);

/** Feed order: most urgent tier first, then score, then most recently seen. */
export function compareFindings(a: { tier: Tier; score: number; last_seen: number }, b: { tier: Tier; score: number; last_seen: number }): number {
  return tierIndex(a.tier) - tierIndex(b.tier) || b.score - a.score || b.last_seen - a.last_seen;
}
