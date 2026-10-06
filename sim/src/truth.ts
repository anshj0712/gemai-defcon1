import { BUGS, type Bug, type Persona, type SimConfig } from './plan.js';

/** One simulated session as it actually ran. All of it is synthetic. */
export interface TruthSession {
  index: number;
  session_id: string | null;
  persona: Persona;
  /** The bug this session ran into, or null for a clean (baseline) session. */
  bug: Bug | null;
  flags: Bug[];
  has_cart: boolean;
  cart_value_minor: number | null;
  currency: 'INR';
  order_placed: boolean;
  /** Had a bag and left without ordering. */
  abandoned: boolean;
  /** Every simulated session is recorded (no sampling), so the baseline is unbiased. */
  sample_rate: 1;
  started_at: number;
  ended_at: number;
  /** Set when the browser run failed; such sessions are left out of scoring. */
  error?: string;
}

export interface GroundTruth {
  v: 1;
  synthetic: true;
  tenant_id: string;
  seed: number;
  started_at: number;
  finished_at: number;
  config: SimConfig;
  sessions: TruthSession[];
}

/** An issue as the API returns it on its detail endpoint (only the fields scoring needs). */
export interface ClusterLike {
  cluster_id: string;
  title: string;
  kind: string;
  anchor: string;
  route: string;
  sessions: string[];
  detectors: Record<string, number>;
}

export interface BugScore {
  bug: Bug;
  /** Sessions that ran into the bug. */
  affected: number;
  /** Issues holding at least one of those sessions (the exit test wants exactly 1). */
  clusters: number;
  cluster_id: string | null;
  title: string | null;
  /** Affected sessions found in that issue / all affected sessions. */
  recall: number;
  /** Affected sessions in that issue / every simulated session in it. */
  precision: number;
}

export interface CheckReport {
  synthetic: true;
  scored_sessions: number;
  failed_sessions: number;
  bugs: BugScore[];
  /** Clean sessions that were put in any issue (the exit test wants none). */
  clean_in_clusters: string[];
  /** Issues holding simulated sessions but none that ran into a bug (pure false positives). */
  unexpected_clusters: { cluster_id: string; title: string; sessions: number }[];
  abandonment: { group: Bug | 'baseline'; with_cart: number; abandoned: number; rate: number }[];
  pass: boolean;
  failures: string[];
}

/** Score this run's sessions against the issues. Sessions from other runs in the same issues are ignored. */
export function evaluate(truth: GroundTruth, clusters: readonly ClusterLike[], minRecall = 0.9): CheckReport {
  const scored = truth.sessions.filter((s) => s.session_id && !s.error);
  const bugOf = new Map(scored.map((s) => [s.session_id!, s.bug]));
  const members = clusters
    .map((c) => ({ c, ids: c.sessions.filter((id) => bugOf.has(id)) }))
    .filter((m) => m.ids.length > 0);

  const failures: string[] = [];
  const claimed = new Set<string>();
  const bugs: BugScore[] = [];
  for (const bug of BUGS) {
    const affected = scored.filter((s) => s.bug === bug).length;
    const holding = members.map((m) => ({ ...m, hits: m.ids.filter((id) => bugOf.get(id) === bug).length })).filter((m) => m.hits > 0);
    const main = [...holding].sort((a, b) => b.hits - a.hits)[0];
    for (const h of holding) claimed.add(h.c.cluster_id);
    const score: BugScore = {
      bug,
      affected,
      clusters: holding.length,
      cluster_id: main?.c.cluster_id ?? null,
      title: main?.c.title ?? null,
      recall: affected ? (main?.hits ?? 0) / affected : 1,
      precision: main ? main.hits / main.ids.length : 1,
    };
    bugs.push(score);
    if (affected === 0) continue;
    if (score.clusters !== 1) failures.push(`${bug}: expected 1 issue, found ${score.clusters}`);
    if (score.recall < minRecall) failures.push(`${bug}: recall ${pct(score.recall)} is below ${pct(minRecall)}`);
    if (score.precision < 1) failures.push(`${bug}: precision ${pct(score.precision)} (its issue holds sessions from other groups)`);
  }

  const clean = members.flatMap((m) => m.ids.filter((id) => bugOf.get(id) === null));
  const cleanInClusters = [...new Set(clean)];
  if (cleanInClusters.length > 0) failures.push(`${cleanInClusters.length} clean session(s) were put in an issue`);
  const unexpected = members.filter((m) => !claimed.has(m.c.cluster_id)).map((m) => ({ cluster_id: m.c.cluster_id, title: m.c.title, sessions: m.ids.length }));
  if (unexpected.length > 0) failures.push(`${unexpected.length} unexpected issue(s): ${unexpected.map((u) => `"${u.title}"`).join(', ')}`);

  const abandonment = (['baseline', ...BUGS] as const).map((group) => {
    const withCart = scored.filter((s) => (group === 'baseline' ? s.bug === null : s.bug === group) && s.has_cart);
    const abandoned = withCart.filter((s) => s.abandoned).length;
    return { group, with_cart: withCart.length, abandoned, rate: withCart.length ? abandoned / withCart.length : 0 };
  });

  return {
    synthetic: true,
    scored_sessions: scored.length,
    failed_sessions: truth.sessions.length - scored.length,
    bugs,
    clean_in_clusters: cleanInClusters,
    unexpected_clusters: unexpected,
    abandonment,
    pass: failures.length === 0,
    failures,
  };
}

export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
