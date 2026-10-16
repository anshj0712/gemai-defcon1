import type { Logger } from '@cp/logger';
import type { BlobStore, StateStore, WarehouseReader } from '@cp/platform';
import { PROBE_NAME, type InvariantRule, type RawChunkRow, type RecordedProbeSpec, type RuleAuthorMeta, type RuleDoc, type RuleFeedback, type WatchFeature, type WatchMeta } from '@cp/schema';
import { CHURN_ANALYST, churnAnalystInput, validateChurnAnalyst, WATCH_PROMPT_VERSION } from '../agents/churn-analyst.js';
import type { ModelSet } from '../llm/models.js';
import { OFFLINE_MODEL_ID } from '../llm/offline.js';
import { runStructured, type RunOptions } from '../llm/run-agent.js';
import type { ProbeCatalog, ProbeStats } from '../rules/evaluate.js';
import { sessionProbes } from '../rules/scan.js';
import type { AgentDraftOptions } from '../rules/service.js';
import { revenueAtRisk, type RevenueParams } from '../scoring/revenue.js';
import { decidedSessions, findSegments, looseSuspects, pendingCartSessions, suggestedLimit, type Segment, type WatchParams } from './contrast.js';
import { sessionNumbers, type SessionNumbers } from './features.js';

/**
 * The churn watcher (ARCHITECTURE.md section 6): it sits on the stream of recorded sessions and looks for what
 * makes shoppers leave, beyond what the detectors and rules already flag.
 *
 *   code     every number sessions report (declared, request and recorded probes) and every short number on their
 *            recorded pages nobody probes yet -> per-session values -> segments of shoppers past a threshold who
 *            abandon far more often than the rest (contrast.ts), minus what issues already explain, what rules
 *            already check, and what a person rejected
 *   Gemini   the churn analyst judges each segment, labels the churn reason, names a probe, writes the rule
 *   code     the rule author and dry run turn the sentence into an agent draft with its proposed probe and the
 *            hypothesis; nothing is flagged until a person approves (the same approve as every rule)
 *
 * Sessions are read from raw once and cached by their last chunk, so a pass reads only what changed.
 */

export interface WatcherDeps {
  state: StateStore;
  reader: WarehouseReader;
  blob: BlobStore;
  models: ModelSet;
  logger: Logger;
  tenants: readonly string[];
  rules: {
    draft(tenantId: string, sentence: string, opts: AgentDraftOptions): Promise<RuleDoc>;
    activeRules(tenantId: string): Promise<InvariantRule[]>;
  };
  params: WatchParams;
  windowDays: number;
  maxSessions: number;
  concurrency: number;
  revenue: RevenueParams;
  runOptions?: RunOptions;
  now?: () => number;
}

export interface WatchResult {
  tenant_id: string;
  sessions: number;
  sessions_read: number;
  numbers: number;
  decided: number;
  candidates: { feature_key: string; title: string | null; lift: number; sessions: number; outcome: 'drafted' | 'declined' | 'failed'; rule_id: string | null; reason: string | null }[];
  ms: number;
}

/** A declined or failed candidate is not asked again unless its gap grows this much. */
const REASK_GROWTH = 1.5;
/** A segment waits while more than this share of its decided size is still deciding. */
const PENDING_SHARE = 0.5;
/** What a decline is remembered by: the number, which side, and the threshold (another segment of it may be real). */
const segmentKey = (s: Pick<Segment, 'feature' | 'direction' | 'threshold'>) => `${s.feature.key}|${s.direction}|${s.threshold}`;
/** ...or this much time has passed (a draft failure may be transient). */
const REASK_AFTER_MS = 10 * 60_000;
const MAX_SEGMENT_IDS = 500;

export function createChurnWatcher(deps: WatcherDeps) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { key: string; numbers: SessionNumbers }>();
  const declined = new Map<string, { lift: number; at: number; reason: string }>();
  const running = new Map<string, Promise<WatchResult>>();
  /** tenant -> shoppers some number may explain, from the latest pass. */
  const suspected = new Map<string, ReadonlySet<string>>();

  async function readSessions(tenantId: string, registry: readonly RecordedProbeSpec[], from: number, to: number) {
    const listed = await deps.reader.chunksInWindow(tenantId, from, to, deps.maxSessions);
    const bySession = new Map<string, RawChunkRow[]>();
    for (const c of listed.chunks) bySession.set(c.session_id, [...(bySession.get(c.session_id) ?? []), c]);
    const registryKey = JSON.stringify(registry);
    const out = new Map<string, SessionNumbers>();
    let read = 0;
    const queue = [...bySession.entries()];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [sessionId, rows] = next;
        const key = `${registryKey}|${rows.length}|${Math.max(...rows.map((r) => r.seq))}`;
        const hit = cache.get(`${tenantId}/${sessionId}`);
        if (hit && hit.key === key) {
          out.set(sessionId, hit.numbers);
          continue;
        }
        try {
          const s = await sessionProbes(deps.blob, tenantId, sessionId, rows, { recordedProbes: registry, discover: true });
          const numbers = sessionNumbers(s, registry);
          cache.set(`${tenantId}/${sessionId}`, { key, numbers });
          out.set(sessionId, numbers);
          read += 1;
        } catch (err) {
          deps.logger.warn({ err, tenant_id: tenantId, session_id: sessionId }, 'churn watcher could not read a session; skipped');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency, queue.length)) }, worker));
    return { sessions: out, read };
  }

  async function pass(tenantId: string): Promise<WatchResult> {
    const started = now();
    const log = deps.logger.child({ tenant_id: tenantId, agent: 'churn_watcher' });
    const from = started - deps.windowDays * 86_400_000;
    const registry = (await deps.state.listProbes(tenantId)).filter((p) => p.status === 'active').map((p) => p.spec);
    const { sessions, read } = await readSessions(tenantId, registry, from, started + 1);

    // Every number, per session (feature key -> session -> the session's largest value).
    const numbers = new Map<string, { feature: WatchFeature; values: Map<string, number> }>();
    for (const [sessionId, n] of sessions) {
      for (const [key, v] of n.values) {
        let entry = numbers.get(key);
        if (!entry) numbers.set(key, (entry = { feature: n.features.get(key)!, values: new Map() }));
        entry.values.set(sessionId, v);
      }
    }

    const outcomes = await deps.reader.sessionOutcomes(tenantId, from);
    // Which pages each shopper reached, from their own events (every number carries the page it was read on). The
    // upload batches' routes are not enough: a batch is named after the page it was flushed on, so brief visits
    // (a product page on the way to the bag) would be missed and the like-for-like baseline would shrink.
    const reached = new Map<string, Set<string>>();
    for (const { feature, values } of numbers.values()) {
      if (!feature.route) continue;
      for (const id of values.keys()) {
        let set = reached.get(id);
        if (!set) reached.set(id, (set = new Set()));
        set.add(feature.route);
      }
    }
    const decided = decidedSessions(outcomes, started, deps.revenue.abandonAfterIdleMs);
    for (const [id, d] of decided) decided.set(id, { ...d, routes: [...new Set([...(d.routes ?? []), ...(reached.get(id) ?? [])])] });
    const pendingCarts = pendingCartSessions(outcomes, started, deps.revenue.abandonAfterIdleMs);
    const clusters = await deps.state.listClusters(tenantId, 500);
    const inIssues = new Set(clusters.flatMap((c) => c.sessions));
    const docs = await deps.state.listRules(tenantId);
    const active = await deps.rules.activeRules(tenantId);
    // Probes a live rule already reads: their numbers are checked already.
    const covered = new Set(active.flatMap((r) => [...r.requires, ...JSON.stringify(r.assert).match(/"(?:probe|sum|count)":"([a-z0-9_]+)"/g)?.map((m) => m.split('"')[3]!) ?? []]));
    const pendingKeys = new Set(docs.flatMap((d) => (d.draft?.watch ? [d.draft.watch.feature.key] : [])));
    const feedback: RuleFeedback[] = docs.flatMap((d) => d.feedback ?? []).sort((a, b) => b.at - a.at);
    const rejectedLift = new Map<string, number>();
    for (const f of feedback) if (f.verdict === 'rejected' && f.feature_key && f.lift !== null) rejectedLift.set(f.feature_key, Math.max(rejectedLift.get(f.feature_key) ?? 0, f.lift));

    // Everyone some number may explain (the loose pass over every number, and pending hypotheses): kept out of the
    // baselines here, and published for revenue at risk elsewhere (shoppers with no known or suspected problem).
    const loose = looseSuspects(numbers, decided, inIssues, deps.params);
    const pendingIds = docs.flatMap((d) => d.draft?.watch?.session_ids ?? []);
    suspected.set(tenantId, new Set([...loose.flatMap((s) => s.sessionIds), ...pendingIds]));

    const eligible = new Map([...numbers].filter(([key, n]) => !pendingKeys.has(key) && !(n.feature.source !== 'discovered' && covered.has(n.feature.name))));
    // Suspects come from every number, so a pending hypothesis still explains its shoppers for the others.
    const segments = findSegments(eligible, decided, inIssues, { ...deps.params, maxCandidates: deps.params.maxCandidates * 4 }, pendingCarts, loose).filter((s) => {
      const rejected = rejectedLift.get(s.feature.key);
      if (rejected !== undefined && s.lift < rejected * REASK_GROWTH) return false;
      const d = declined.get(segmentKey(s));
      if (d && s.lift < d.lift * REASK_GROWTH && started - d.at < REASK_AFTER_MS) return false;
      // Wait while most of the segment's shoppers are still deciding: a hypothesis is drafted once, so draft it whole.
      if (s.pending > s.segment.sessions * PENDING_SHARE) {
        log.debug({ feature: s.feature.key, decided: s.segment.sessions, pending: s.pending }, 'churn segment still settling; waiting');
        return false;
      }
      return true;
    });

    const result: WatchResult = { tenant_id: tenantId, sessions: sessions.size, sessions_read: read, numbers: numbers.size, decided: decided.size, candidates: [], ms: 0 };
    const catalog = catalogOf(numbers);
    const taken = new Set([...catalog.probes.map((p) => p.name), ...registry.map((p) => p.name), ...docs.flatMap((d) => d.draft?.proposed_probes?.map((p) => p.name) ?? [])]);
    const currency = outcomes.find((o) => o.currency)?.currency ?? null;

    for (const seg of segments.slice(0, deps.params.maxCandidates)) {
      const feature = seg.feature.source === 'discovered' ? { ...seg.feature, name: freeName(seg.feature.name, taken) } : seg.feature;
      const segment: Segment = { ...seg, feature };
      const limit = suggestedLimit(segment);
      // The same baseline as the segment's: shoppers neither in an issue nor explained by another suspected number.
      const notBaseline = seg.explainedElsewhere ? new Set([...inIssues, ...seg.explainedElsewhere]) : inIssues;
      const revenue = revenueAtRisk(
        { affectedSessionIds: seg.sessionIds, affectedSessionCount: seg.sessionIds.length, route: feature.route ?? '', sessionsInAnyIssue: notBaseline, outcomes, now: started },
        deps.revenue,
      );
      const { input, evidence } = churnAnalystInput({ segment, suggestedLimit: limit, revenue, catalog, rules: active, feedback: feedback.slice(0, 10), currency });
      const res = await runStructured(CHURN_ANALYST, deps.models.reasoning, input, (o) => validateChurnAnalyst(o, { supplied: evidence.all, segment, takenNames: taken }), deps.runOptions);
      const out = res.output;
      const meta: RuleAuthorMeta = {
        model: res.run.model,
        prompt_hash: res.run.prompt_hash,
        offline: res.run.model === OFFLINE_MODEL_ID,
        explanation: out?.hypothesis.text ?? '',
        evidence_ids: out?.hypothesis.evidence_ids ?? [],
        assumptions: out?.assumptions ?? [],
        attempts: res.run.attempts,
        ms: res.run.ms,
      };
      const record = (outcome: WatchResult['candidates'][number]['outcome'], ruleId: string | null, reason: string | null) => {
        result.candidates.push({ feature_key: feature.key, title: out?.title || null, lift: round(seg.lift), sessions: seg.sessionIds.length, outcome, rule_id: ruleId, reason });
        if (outcome !== 'drafted') declined.set(segmentKey(seg), { lift: seg.lift, at: started, reason: reason ?? outcome });
      };
      if (!out) {
        log.warn({ feature: feature.key, model: meta.model, attempts: meta.attempts, error: res.run.error }, 'churn analyst gave no valid answer');
        record('failed', null, res.run.error ?? 'no answer');
        continue;
      }
      if (!out.propose) {
        log.info({ feature: feature.key, lift: round(seg.lift), sessions: seg.sessionIds.length }, 'churn analyst declined the candidate');
        record('declined', null, out.hypothesis.text.slice(0, 200));
        continue;
      }
      const name = feature.source === 'discovered' ? out.probe_name.trim() : feature.name;
      const proposedProbes: RecordedProbeSpec[] =
        feature.source === 'discovered' && feature.selector && PROBE_NAME.test(name) ? [{ name, selector: feature.selector, ...(feature.route ? { routes: [feature.route] } : {}), kind: feature.unit === 'money' ? 'money' : 'count' }] : [];
      const watch: WatchMeta = {
        feature: { ...feature, name },
        direction: seg.direction,
        threshold: seg.threshold,
        segment: seg.segment,
        baseline: seg.baseline,
        lift: seg.lift,
        p_value: seg.p,
        values: seg.values,
        session_ids: seg.sessionIds.slice(0, MAX_SEGMENT_IDS),
        churn_reason: out.churn_reason,
        title: out.title,
        hypothesis: out.hypothesis.text,
        confidence: out.confidence,
        found_at: started,
      };
      try {
        const doc = await deps.rules.draft(tenantId, out.sentence, { origin: 'agent', cluster_id: null, suggester: meta, proposedProbes, watch });
        taken.add(name);
        log.info({ feature: feature.key, rule_id: doc.rule_id, lift: round(seg.lift), sessions: seg.sessionIds.length, churn_reason: out.churn_reason, prompt: WATCH_PROMPT_VERSION }, 'churn hypothesis drafted');
        record('drafted', doc.rule_id, null);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn({ feature: feature.key, error: reason }, 'churn hypothesis could not be drafted');
        record('failed', null, reason.slice(0, 200));
      }
    }
    result.ms = now() - started;
    log.info({ sessions: result.sessions, read: result.sessions_read, numbers: result.numbers, decided: result.decided, candidates: result.candidates.length, ms: result.ms }, 'churn watch pass');
    return result;
  }

  return {
    /** One pass for one tenant; a pass already running is joined, not started twice. */
    run(tenantId: string): Promise<WatchResult> {
      if (!deps.tenants.includes(tenantId)) return Promise.reject(new Error(`tenant ${tenantId} is not served by this agent`));
      let p = running.get(tenantId);
      if (!p) {
        p = pass(tenantId).finally(() => running.delete(tenantId));
        running.set(tenantId, p);
      }
      return p;
    },
    async runAll(): Promise<WatchResult[]> {
      const out: WatchResult[] = [];
      for (const t of deps.tenants) out.push(await this.run(t));
      return out;
    },
    /**
     * Shoppers a number may explain (the latest pass's loose segments and pending hypotheses). Revenue at risk keeps
     * them out of its baseline, so unexplained problems do not make every other problem look harmless.
     */
    suspected(tenantId: string): ReadonlySet<string> {
      return suspected.get(tenantId) ?? new Set();
    },
  };
}

export type ChurnWatcher = ReturnType<typeof createChurnWatcher>;

const round = (x: number) => Math.round(x * 1000) / 1000;

function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** A light probe catalog from the numbers the pass read (existing probes only), for the analyst's context. */
function catalogOf(numbers: ReadonlyMap<string, { feature: { name: string; source: string; route: string | null }; values: ReadonlyMap<string, number> }>): ProbeCatalog {
  const probes: ProbeStats[] = [];
  const routes = new Set<string>();
  for (const { feature, values } of numbers.values()) {
    if (feature.source === 'discovered') continue;
    const sorted = [...values.values()].sort((a, b) => a - b);
    if (feature.route) routes.add(feature.route);
    probes.push({
      name: feature.name,
      source: feature.source as ProbeStats['source'],
      snapshots: sorted.length,
      values_per_snapshot: { min: 1, max: 1 },
      min: sorted[0] ?? 0,
      median: sorted[Math.floor(sorted.length / 2)] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
      routes: feature.route ? [feature.route] : [],
    });
  }
  return { probes: probes.sort((a, b) => a.name.localeCompare(b.name)), routes: [...routes].sort(), currencies: [], sessions: 0 };
}
