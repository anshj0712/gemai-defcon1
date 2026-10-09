import { createHash } from 'node:crypto';
import type { Logger } from '@cp/logger';
import type { BlobStore, ReplayPayload, SessionOutcome, WarehouseReader } from '@cp/platform';
import type { AgentRun, Cluster, EvidenceItem, Finding, FindingRow, FindingScreenshot, PriorityRule, RankOutput, RootCauseOutput, SignalRow, TriageOutput } from '@cp/schema';
import { PROMPT_VERSION, RANKER, rankerInput, ROOT_CAUSE, rootCauseInput, TRIAGE, triageInput } from './agents/prompts.js';
import { buildEvidence, screenshotEvidence } from './evidence.js';
import { validateRank, validateRootCause, validateTriage } from './grounding.js';
import type { ModelSet } from './llm/models.js';
import { runStructured, type RunOptions } from './llm/run-agent.js';
import { baseTier, isRegression, rank, revenueAtRisk, ruleSetVersion, type RevenueParams } from './scoring/index.js';
import type { Screenshotter } from './visual/screenshot.js';

/**
 * Turns one cluster into its next finding version:
 *
 *   deterministic:  revenue at risk -> base tier -> evidence pack
 *   agents (cached per llm_key):  triage -> screenshot + root cause (visual check) -> ranker
 *   deterministic:  bounded tier move -> score -> status
 *
 * The LLM steps re-run only when the cluster's nature changes (symptoms, errors, releases, rule set,
 * models, prompts) or its session count doubles; scores are recomputed on every pass.
 */

export interface PipelineDeps {
  reader: WarehouseReader;
  blob: BlobStore;
  models: ModelSet;
  rules: readonly PriorityRule[];
  screenshotter: Screenshotter | null;
  logger: Logger;
  revenue: RevenueParams;
  regressionWindowMs: number;
  /** How far back signals and replays are read. */
  lookbackMs: number;
  runOptions?: RunOptions;
  now?: () => number;
  /** Replay loader (injectable for tests). */
  loadReplay: (tenantId: string, sessionId: string) => Promise<ReplayPayload | null>;
}

/** Per-pass context shared by every cluster of a tenant. */
export interface TenantContext {
  outcomes: readonly SessionOutcome[];
  sessionsInAnyIssue: ReadonlySet<string>;
  releaseFirstSeen: ReadonlyMap<string, number>;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function tenantContext(clusters: readonly Cluster[], outcomes: readonly SessionOutcome[]): TenantContext {
  const releaseFirstSeen = new Map<string, number>();
  for (const o of outcomes) for (const r of o.releases) releaseFirstSeen.set(r, Math.min(releaseFirstSeen.get(r) ?? Infinity, o.first_seen));
  return { outcomes, sessionsInAnyIssue: new Set(clusters.flatMap((c) => c.sessions)), releaseFirstSeen };
}

/** What decides whether the agents must run again for this cluster. */
export function llmKey(c: Cluster, rules: readonly PriorityRule[], models: ModelSet, screenshots: boolean): string {
  const keys = (o: Record<string, number>) => Object.keys(o).sort();
  return sha(
    JSON.stringify([
      PROMPT_VERSION,
      c.kind,
      c.route,
      c.anchor,
      keys(c.detectors),
      keys(c.error_signatures),
      keys(c.releases),
      [...c.fingerprints].sort(),
      // Re-analyse as the issue grows (1, 2, 4, 8, ... sessions), so early one-session evidence does not stick.
      Math.floor(Math.log2(Math.max(1, c.session_count))),
      ruleSetVersion(rules),
      models.bulk.model,
      models.reasoning.model,
      screenshots,
    ]),
  ).slice(0, 20);
}

async function evidenceSignals(deps: PipelineDeps, c: Cluster, sinceMs: number): Promise<SignalRow[]> {
  const sessions = [...new Set(c.evidence.map((e) => e.session_id))];
  const wanted = new Set(c.evidence.map((e) => e.signal_id));
  const rows = await Promise.all(sessions.map((s) => deps.reader.signals({ tenantId: c.tenant_id, sessionId: s, sinceMs, limit: 500 })));
  return rows.flat().filter((r) => wanted.has(r.signal_id));
}

interface Shot {
  png: Buffer;
  meta: Omit<FindingScreenshot, 'evidence_id'>;
}

async function takeScreenshot(deps: PipelineDeps, c: Cluster, log: Logger): Promise<Shot | null> {
  if (!deps.screenshotter) return null;
  for (const e of c.evidence.slice(0, 3)) {
    try {
      const replay = await deps.loadReplay(c.tenant_id, e.session_id);
      const marker = replay?.markers.find((m) => m.signal_id === e.signal_id);
      if (!replay || !marker) continue;
      const { png, offsetMs } = await deps.screenshotter.capture(replay.events, marker);
      const path = `screenshots/${c.tenant_id}/${c.cluster_id}/${e.signal_id}.png`;
      const { uri } = await deps.blob.putIfAbsent(path, png, 'image/png');
      return { png, meta: { signal_id: e.signal_id, session_id: e.session_id, uri, offset_ms: offsetMs, captured_at: (deps.now ?? Date.now)() } };
    } catch (err) {
      log.warn({ err, signal_id: e.signal_id }, 'screenshot failed; trying the next occurrence');
    }
  }
  return null;
}

interface Enrichment {
  evidence: EvidenceItem[];
  triage: TriageOutput | null;
  root_cause: RootCauseOutput | null;
  ranker: RankOutput | null;
  screenshot: FindingScreenshot | null;
  runs: AgentRun[];
}

export async function analyze(deps: PipelineDeps, cluster: Cluster, ctx: TenantContext, previous: Finding | null): Promise<Finding> {
  const now = (deps.now ?? Date.now)();
  const log = deps.logger.child({ tenant_id: cluster.tenant_id, cluster_id: cluster.cluster_id });
  const sinceMs = now - deps.lookbackMs;

  const revenue = revenueAtRisk(
    { affectedSessionIds: cluster.sessions, affectedSessionCount: cluster.session_count, route: cluster.route, sessionsInAnyIssue: ctx.sessionsInAnyIssue, outcomes: ctx.outcomes, now },
    deps.revenue,
  );
  const regression = isRegression(Object.keys(cluster.releases), cluster.first_seen, ctx.releaseFirstSeen, deps.regressionWindowMs);
  const base = baseTier(cluster, deps.rules);
  const key = llmKey(cluster, deps.rules, deps.models, deps.screenshotter !== null);

  let enr: Enrichment;
  const reusable = previous && previous.llm_key === key && previous.runs.length > 0 && previous.runs.every((r) => r.ok);
  if (reusable) {
    // Same nature, same prompts and models: keep the analysis and the exact evidence pack it cites.
    enr = { evidence: previous.evidence, triage: previous.triage, root_cause: previous.root_cause, ranker: previous.ranker, screenshot: previous.screenshot, runs: previous.runs };
  } else {
    const signals = await evidenceSignals(deps, cluster, sinceMs);
    const evidence = buildEvidence({ cluster, signals, revenue, regression });
    const runs: AgentRun[] = [];

    const t = await runStructured(TRIAGE, deps.models.bulk, triageInput(evidence), (o) => validateTriage(o, new Set(evidence.map((e) => e.id))), deps.runOptions);
    runs.push(t.run);

    const shot = await takeScreenshot(deps, cluster, log);
    let screenshot: FindingScreenshot | null = null;
    if (shot) {
      const id = `E${evidence.length + 1}`;
      evidence.push(screenshotEvidence(id, shot.meta, evidence.find((e) => e.signal_id === shot.meta.signal_id)));
      screenshot = { evidence_id: id, ...shot.meta };
    }
    const ids = new Set(evidence.map((e) => e.id));
    const rc = await runStructured(
      ROOT_CAUSE,
      deps.models.reasoning,
      rootCauseInput(evidence, t.output, shot?.png ?? null),
      (o) => validateRootCause(o, ids, screenshot?.evidence_id ?? null),
      deps.runOptions,
    );
    runs.push(rc.run);

    const rk = await runStructured(
      RANKER,
      deps.models.bulk,
      rankerInput(evidence, { base_tier: base.tier, base_rule_ids: base.ruleIds, revenue, triage: t.output }, deps.rules),
      (o) => validateRank(o, ids, deps.rules),
      deps.runOptions,
    );
    runs.push(rk.run);
    for (const r of runs) {
      if (r.ok) log.info({ agent: r.agent, model: r.model, attempts: r.attempts, ms: r.ms, prompt_hash: r.prompt_hash }, 'agent answered');
      else log.warn({ agent: r.agent, model: r.model, attempts: r.attempts, error: r.error }, 'agent output rejected; failing closed');
    }
    enr = { evidence, triage: t.output, root_cause: rc.output, ranker: rk.output, screenshot, runs };
  }

  const ranked = rank(cluster, revenue, deps.rules, { regression, ranker: enr.ranker });
  if (ranked.rejected) log.info({ reason: ranked.rejected }, 'ranker move not applied');
  const status: Finding['status'] = enr.root_cause?.visual_check === 'not_confirmed' ? 'suspect' : 'open';
  const modelVersion = [...new Set(enr.runs.map((r) => r.model))].join('+') || 'none';
  const promptHash = sha(enr.runs.map((r) => `${r.agent}:${r.prompt_hash}`).join('|')).slice(0, 16);

  const finding: Finding = {
    v: 1,
    tenant_id: cluster.tenant_id,
    finding_id: cluster.cluster_id,
    cluster_id: cluster.cluster_id,
    version: previous?.version ?? 0,
    kind: cluster.kind,
    title: enr.triage?.title ?? cluster.title,
    cluster_title: cluster.title,
    route: cluster.route,
    anchor: cluster.anchor,
    status,
    tier: ranked.tier,
    score: ranked.score,
    priority: ranked.priority,
    revenue,
    triage: enr.triage,
    root_cause: enr.root_cause,
    ranker: enr.ranker,
    evidence: enr.evidence,
    screenshot: enr.screenshot,
    runs: enr.runs,
    llm_key: key,
    input_hash: '',
    affected_sessions: cluster.session_count,
    signal_count: cluster.signal_count,
    detectors: cluster.detectors,
    releases: Object.keys(cluster.releases),
    first_seen: cluster.first_seen,
    last_seen: cluster.last_seen,
    model_version: modelVersion,
    prompt_hash: promptHash,
    rule_version: ranked.priority.rule_set_version,
    created_at: previous?.created_at ?? now,
    updated_at: now,
    synthetic: true,
  };
  finding.input_hash = versionHash(finding);
  finding.version = previous && previous.input_hash === finding.input_hash ? previous.version : (previous?.version ?? 0) + 1;
  return finding;
}

/**
 * What makes a new finding version: the analysis, tier, score, status, and impact. Signal counts and
 * last_seen move with every signal and only refresh the hot copy.
 */
export function versionHash(f: Finding): string {
  return sha(
    JSON.stringify([
      f.llm_key,
      f.runs.map((r) => r.prompt_hash),
      f.tier,
      f.status,
      f.score,
      f.priority,
      f.revenue.revenue_at_risk_minor,
      f.revenue.status,
      f.affected_sessions,
      f.first_seen,
    ]),
  ).slice(0, 20);
}

/** The append-only BigQuery row for one finding version (bitemporal: valid and transaction time). */
export function toFindingRow(f: Finding, recordedAt: number): FindingRow {
  return {
    tenant_id: f.tenant_id,
    finding_id: f.finding_id,
    fingerprint: f.cluster_id,
    severity: f.tier,
    revenue_at_risk_minor: f.revenue.revenue_at_risk_minor,
    currency: f.revenue.currency ?? '',
    affected_sessions: f.affected_sessions,
    summary: f.triage?.summary.text ?? f.cluster_title,
    evidence_refs: {
      signal_ids: f.evidence.filter((e) => e.signal_id).map((e) => e.signal_id!),
      session_ids: [...new Set(f.evidence.filter((e) => e.session_id).map((e) => e.session_id!))],
      screenshot_uri: f.screenshot?.uri ?? null,
    },
    rule_version: f.rule_version,
    model_version: f.model_version,
    prompt_hash: f.prompt_hash,
    cluster_id: f.cluster_id,
    title: f.title,
    status: f.status,
    score: f.score,
    input_hash: f.input_hash,
    details: {
      version: f.version,
      priority: f.priority,
      revenue: f.revenue,
      triage: f.triage,
      root_cause: f.root_cause,
      ranker: f.ranker,
      runs: f.runs,
      evidence: f.evidence,
      llm_key: f.llm_key,
      synthetic: true,
    },
    valid_from: f.first_seen,
    valid_to: null,
    recorded_from: recordedAt,
    recorded_to: null,
  };
}
