import { createHash } from 'node:crypto';
import { BUILTIN_RULES } from '@cp/detectors';
import type { Logger } from '@cp/logger';
import type { BlobStore, ReplayPayload, SessionOutcome, WarehouseReader } from '@cp/platform';
import type {
  AgentRun,
  Cluster,
  EvidenceItem,
  Finding,
  FindingDiscovery,
  FindingRow,
  FindingRuleSuggestion,
  FindingVerdict,
  FindingScreenshot,
  InvariantRule,
  PriorityRule,
  RankOutput,
  RevenueAtRisk,
  RootCauseOutput,
  RuleAuthorMeta,
  RuleDoc,
  SignalRow,
  TriageOutput,
} from '@cp/schema';
import { PROMPT_VERSION, RANKER, rankerInput, ROOT_CAUSE, rootCauseInput, TRIAGE, triageInput } from './agents/prompts.js';
import { RULE_SUGGESTER, ruleSuggesterInput, SUGGEST_PROMPT_VERSION } from './agents/rule-suggester.js';
import { buildEvidence, screenshotEvidence } from './evidence.js';
import { convene, juryKey, type JuryParams } from './jury.js';
import { validateRank, validateRootCause, validateRuleSuggestion, validateTriage } from './grounding.js';
import type { ModelSet } from './llm/models.js';
import { OFFLINE_MODEL_ID } from './llm/offline.js';
import { runStructured, type RunOptions } from './llm/run-agent.js';
import type { ProbeCatalog } from './rules/evaluate.js';
import { RuleError } from './rules/service.js';
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
 *
 * Optionally (deps.ruleSuggest), a recurring issue that a deterministic trigger picks is shown to the
 * rule suggester, whose sentence becomes an agent-originated rule draft (ARCHITECTURE.md section 6).
 * That step only fills `finding.rule_suggestion` on the hot copy: it never changes the finding's
 * analysis, tier, score, or version.
 */

/** When the rule suggester is asked about an issue (all from config: RULE_SUGGEST_*). */
export interface RuleSuggestParams {
  enabled: boolean;
  /** At least this many affected sessions. */
  minSessions: number;
  /** Seen over at least this many days (first to last signal). */
  minDays: number;
  /** The issue's most frequent detector carries at least this share of its signals (0 to 1). */
  minDetectorShare: number;
  /** Most of the issue's sessions read for probe statistics. */
  maxSessions: number;
}

/** The rule service as the suggestion step sees it (wired in index.ts). */
export interface RuleSuggestDeps {
  params: RuleSuggestParams;
  activeRules(tenantId: string): Promise<InvariantRule[]>;
  probeStats(tenantId: string, sessionIds: string[]): Promise<ProbeCatalog>;
  /** Hand the sentence to the rule author as an agent-originated draft (same compile, validate, dry run). */
  draft(tenantId: string, sentence: string, meta: { cluster_id: string; suggester: RuleAuthorMeta }): Promise<RuleDoc>;
}

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
  /** Agent-suggested rules; absent means the step never runs. */
  ruleSuggest?: RuleSuggestDeps;
  /** The jury that reviews each finished report; absent means findings are not reviewed. */
  jury?: JuryParams;
}

/** Per-pass context shared by every cluster of a tenant. */
export interface TenantContext {
  outcomes: readonly SessionOutcome[];
  sessionsInAnyIssue: ReadonlySet<string>;
  releaseFirstSeen: ReadonlyMap<string, number>;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * `suspected`: shoppers the churn watcher thinks some number may explain. They stay out of revenue at risk's
 * baseline like shoppers in an issue, so problems nobody has flagged yet do not make the others look harmless.
 */
export function tenantContext(clusters: readonly Cluster[], outcomes: readonly SessionOutcome[], suspected: ReadonlySet<string> = new Set()): TenantContext {
  const releaseFirstSeen = new Map<string, number>();
  for (const o of outcomes) for (const r of o.releases) releaseFirstSeen.set(r, Math.min(releaseFirstSeen.get(r) ?? Infinity, o.first_seen));
  return { outcomes, sessionsInAnyIssue: new Set([...clusters.flatMap((c) => c.sessions), ...suspected]), releaseFirstSeen };
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
      const path = `screenshots/${c.tenant_id}/${c.cluster_id}/${e.signal_id}-t${offsetMs}.png`;
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

  const suggestion = await suggestRule(deps, cluster, revenue, enr, key, previous, now, log);

  const ranked = rank(cluster, revenue, deps.rules, { regression, ranker: enr.ranker });
  if (ranked.rejected) log.info({ reason: ranked.rejected }, 'ranker move not applied');
  const visualOk = enr.root_cause?.visual_check !== 'not_confirmed';
  const verdict = await reviewReport(deps, cluster, revenue, ranked.tier, enr, key, previous, visualOk, log);
  // Held back by the screenshot, or by a jury that read the report and did not approve it.
  const status: Finding['status'] = !visualOk || verdict?.outcome === 'rejected' ? 'suspect' : 'open';
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
    discovery: discoveryOf(cluster),
    ...(suggestion ? { rule_suggestion: suggestion } : {}),
    ...(verdict ? { verdict } : {}),
    ...(previous?.resolution ? { resolution: previous.resolution } : {}),
    synthetic: true,
  };
  finding.input_hash = versionHash(finding);
  finding.version = previous && previous.input_hash === finding.input_hash ? previous.version : (previous?.version ?? 0) + 1;
  return finding;
}

/**
 * The jury step. The same finished report is not judged twice: the verdict is kept while the finding's own
 * key and the jury's settings stay the same, and re-convened when a pass could not reach enough jurors.
 * Without triage output there is no report to review. Never throws.
 */
async function reviewReport(
  deps: PipelineDeps,
  cluster: Cluster,
  revenue: RevenueAtRisk,
  tier: Finding['tier'],
  enr: Enrichment,
  llmKeyValue: string,
  previous: Finding | null,
  visualOk: boolean,
  log: Logger,
): Promise<FindingVerdict | undefined> {
  if (!deps.jury || !enr.triage) return undefined;
  const agentsOk = enr.runs.every((r) => r.ok);
  const reviewed = sha(JSON.stringify([enr.runs.map((r) => `${r.agent}:${r.prompt_hash}:${r.ok}`), visualOk, tier, enr.triage.title]));
  const key = juryKey(llmKeyValue, { models: deps.models, params: deps.jury }, reviewed);
  if (previous?.verdict && previous.verdict.key === key && previous.verdict.outcome !== 'unavailable') return previous.verdict;
  try {
    const verdict = await convene(
      { models: deps.models, params: deps.jury, ...(deps.runOptions ? { runOptions: deps.runOptions } : {}), logger: log, ...(deps.now ? { now: deps.now } : {}) },
      {
        report: {
          title: enr.triage.title,
          tier,
          affected_sessions: cluster.session_count,
          revenue: { status: revenue.status, revenue_at_risk_minor: revenue.revenue_at_risk_minor, currency: revenue.currency, note: revenue.note },
          triage: enr.triage,
          root_cause: enr.root_cause,
          ranker: enr.ranker,
        },
        evidence: enr.evidence,
        checks: { agents_ok: agentsOk, visual_ok: visualOk },
        key,
      },
    );
    log.info({ outcome: verdict.outcome, mean: verdict.mean_score, answered: verdict.jurors_answered }, 'jury verdict');
    return verdict;
  } catch (err) {
    log.warn({ err: errorText(err) }, 'the jury could not convene; the report is left unreviewed');
    return undefined;
  }
}

const DAY_MS = 86_400_000;
const BUILTIN_RULE_IDS: ReadonlySet<string> = new Set(BUILTIN_RULES.map((r) => r.id));
/** How runStructured reports a model it could not reach (as opposed to an answer the validator rejected). */
const MODEL_CALL_FAILED = 'model call failed';

/**
 * The deterministic trigger for the rule suggester (AGENTS.md rule 1: code decides, Gemini drafts). A
 * recurring issue qualifies when every condition holds: enough sessions, seen over enough days, one
 * dominant symptom, not a data rule that an active rule already explains, and a revenue estimate. The
 * route is fixed per issue by the clusterer's key.
 */
export function shouldSuggestRule(cluster: Cluster, revenue: RevenueAtRisk, activeRuleIds: ReadonlySet<string>, params: RuleSuggestParams): { ok: boolean; reason: string } {
  if (!params.enabled) return { ok: false, reason: 'rule suggestions are off' };
  if (cluster.session_count < params.minSessions) return { ok: false, reason: `${cluster.session_count} sessions, fewer than ${params.minSessions}` };
  const days = (cluster.last_seen - cluster.first_seen) / DAY_MS;
  if (cluster.last_seen - cluster.first_seen < params.minDays * DAY_MS) return { ok: false, reason: `seen over ${days.toFixed(2)} days, fewer than ${params.minDays}` };
  const dominant = Math.max(0, ...Object.values(cluster.detectors));
  const share = cluster.signal_count > 0 ? dominant / cluster.signal_count : 0;
  if (share < params.minDetectorShare) return { ok: false, reason: `the most frequent symptom is ${Math.round(share * 100)}% of signals, below ${Math.round(params.minDetectorShare * 100)}%` };
  if (cluster.kind === 'invariant' && activeRuleIds.has(cluster.anchor)) return { ok: false, reason: `already explained by the active rule ${cluster.anchor}` };
  if (revenue.status !== 'ok') return { ok: false, reason: 'no revenue estimate yet' };
  return { ok: true, reason: `${cluster.session_count} sessions over ${days.toFixed(2)} days, ${Math.round(share * 100)}% one symptom` };
}

/** Cache key of a suggestion: the issue's llm_key (nature, size class, models) and the suggester prompt. */
export const suggestionKey = (llmKeyValue: string) => sha(JSON.stringify([llmKeyValue, SUGGEST_PROMPT_VERSION])).slice(0, 20);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/**
 * The suggestion step. A drafted suggestion is never asked again; a declined or failed one only when its
 * key changes. When the trigger does not trip, whatever the issue had is kept. Never throws. An answer is
 * remembered (declined; failed for an output the validator rejected or a rule service verdict such as a
 * conflict); a transient failure (store read, model unreachable, draft not written) is not, so the next
 * re-score pass tries again, as the other agents do.
 */
async function suggestRule(
  deps: PipelineDeps,
  cluster: Cluster,
  revenue: RevenueAtRisk,
  enr: Enrichment,
  llmKeyValue: string,
  previous: Finding | null,
  now: number,
  log: Logger,
): Promise<FindingRuleSuggestion | undefined> {
  const prev = previous?.rule_suggestion;
  const rs = deps.ruleSuggest;
  if (prev?.status === 'drafted') return prev;
  const key = suggestionKey(llmKeyValue);
  if (prev && prev.key === key) return prev;
  if (!rs?.params.enabled) return prev;

  let run: AgentRun = { agent: RULE_SUGGESTER.name, model: deps.models.bulk.model, prompt_hash: '', attempts: 0, ok: false, error: null, ms: 0, at: now };
  let sentence: string | null = null;
  const outcome = (status: FindingRuleSuggestion['status'], ruleId: string | null, reason: string | null): FindingRuleSuggestion => {
    const fields = { agent: run.agent, model: run.model, attempts: run.attempts, status, rule_id: ruleId };
    if (status === 'failed') log.warn({ ...fields, error: reason }, 'rule suggestion failed');
    else log.info({ ...fields, ms: run.ms, prompt_hash: run.prompt_hash }, status === 'drafted' ? 'rule suggestion drafted' : 'rule suggestion declined');
    return { key, status, rule_id: ruleId, sentence, reason, run, at: now };
  };

  // The cheap conditions first, so an issue that cannot qualify costs no store reads on any pass.
  // Built-in rules are always active, so an issue anchored on one needs no rules read either.
  const cheap = shouldSuggestRule(cluster, revenue, BUILTIN_RULE_IDS, rs.params);
  if (!cheap.ok) {
    log.debug({ reason: cheap.reason }, 'rule suggester not asked');
    return prev;
  }
  let active: InvariantRule[];
  let catalog: ProbeCatalog;
  try {
    active = await rs.activeRules(cluster.tenant_id);
    const trigger = shouldSuggestRule(cluster, revenue, new Set(active.map((r) => r.id)), rs.params);
    if (!trigger.ok) {
      log.debug({ reason: trigger.reason }, 'rule suggester not asked');
      return prev;
    }
    catalog = await rs.probeStats(cluster.tenant_id, cluster.sessions.slice(0, rs.params.maxSessions));
  } catch (err) {
    // A store hiccup before the model is asked is not an answer: keep what the issue had and try next pass.
    log.warn({ error: errorText(err) }, 'rule suggestion skipped this pass: rules or probe statistics could not be read');
    return prev;
  }

  try {
    const { input, evidenceIds, probeIds } = ruleSuggesterInput(enr.evidence, { triage: enr.triage, revenue }, catalog, active);
    const res = await runStructured(RULE_SUGGESTER, deps.models.bulk, input, (o) => validateRuleSuggestion(o, evidenceIds, probeIds), deps.runOptions);
    run = res.run;
    const out = res.output;
    if (!out && run.error?.startsWith(MODEL_CALL_FAILED)) {
      // The model could not be reached (after runStructured's back-off): not an answer, so try next pass.
      log.warn({ agent: run.agent, model: run.model, attempts: run.attempts, error: run.error }, 'rule suggestion skipped this pass: the model call failed');
      return prev;
    }
    if (!out) return outcome('failed', null, run.error ?? 'the rule suggester gave no valid answer');
    if (!out.propose) return outcome('declined', null, out.explanation.text);

    sentence = out.sentence.trim();
    const suggester: RuleAuthorMeta = {
      model: run.model,
      prompt_hash: run.prompt_hash,
      offline: run.model === OFFLINE_MODEL_ID,
      explanation: out.explanation.text,
      evidence_ids: out.explanation.evidence_ids,
      assumptions: out.assumptions,
      attempts: run.attempts,
      ms: run.ms,
    };
    let doc: RuleDoc;
    try {
      doc = await rs.draft(cluster.tenant_id, sentence, { cluster_id: cluster.cluster_id, suggester });
    } catch (err) {
      // A rule service verdict (conflict, no hits, not understood, author failed) is an answer: remember it.
      if (err instanceof RuleError) return outcome('failed', null, errorText(err));
      // Anything else (a store or network error) is transient: keep what the issue had and try next pass.
      log.warn({ agent: run.agent, model: run.model, error: errorText(err) }, 'rule suggestion skipped this pass: the draft could not be written');
      return prev;
    }
    return outcome('drafted', doc.rule_id, null);
  } catch (err) {
    return outcome('failed', null, errorText(err));
  }
}

/** Known at the time, or found later: sessions a retroactive re-scan added to the issue. */
export function discoveryOf(c: Cluster): FindingDiscovery {
  const sessions = c.found_later?.sessions ?? 0;
  return { found_later: sessions > 0, found_later_sessions: sessions, rescan_ids: Object.keys(c.found_later?.rescans ?? {}) };
}

/**
 * What makes a new finding version: the analysis, tier, score, status, and impact. Signal counts and
 * last_seen move with every signal and only refresh the hot copy. (Sessions found later always change
 * affected_sessions too, so discovery needs no place here.)
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
      // Enough to show this version in an as-of view without the hot copy (Phase 4).
      kind: f.kind,
      route: f.route,
      anchor: f.anchor,
      cluster_title: f.cluster_title,
      last_seen: f.last_seen,
      discovery: f.discovery ?? null,
      synthetic: true,
    },
    valid_from: f.first_seen,
    valid_to: null,
    recorded_from: recordedAt,
    recorded_to: null,
  };
}
