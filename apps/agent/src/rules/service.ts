import { BUILTIN_RULES, shortHash } from '@cp/detectors';
import type { Logger } from '@cp/logger';
import { compileSelector } from '@cp/normalizer';
import type { BlobStore, Publisher, StateStore, Warehouse, WarehouseReader } from '@cp/platform';
import {
  isRequestProbe,
  RecordedProbeSpecSchema,
  REQUEST_PROBE_PREFIX,
  ruleVersionOf,
  type InvariantRule,
  type ProbeDoc,
  type ProbePreview,
  type RawChunkRow,
  type RecordedProbeSpec,
  type RevenueAtRisk,
  type RuleAuthorMeta,
  type RuleDoc,
  type RuleFeedback,
  type WatchMeta,
} from '@cp/schema';
import { RULE_AUTHOR, ruleAuthorInput } from '../agents/rule-author.js';
import { SENTENCE_LIMITS } from '../grounding.js';
import type { ModelSet } from '../llm/models.js';
import { OFFLINE_MODEL_ID } from '../llm/offline.js';
import { runStructured, type RunOptions } from '../llm/run-agent.js';
import { revenueAtRisk, type RevenueParams } from '../scoring/revenue.js';
import { compileRule, validateRuleAuthor } from './compile.js';
import { buildCatalog, dryRun, previewProbe, type ProbeCatalog } from './evaluate.js';
import { initialStatus, runRescan } from './rescan.js';
import { scanWindow, sessionProbes, type SessionProbes } from './scan.js';

/**
 * Tenant rules, end to end (ARCHITECTURE.md section 6):
 *
 *   draft    sentence -> probe catalog from recent raw sessions -> rule author (Gemini) -> compile and
 *            validate -> dry run over the same sessions -> pending draft on the rule's hot doc
 *   approve  a person approves the draft -> `rules` row (the bitemporal record of rule versions) ->
 *            the processor picks the rule up for live traffic -> a re-scan of the past window starts
 *   reject   drops the draft
 *   rescan   runs the approved version over the window again (idempotent)
 *
 * A draft has one of two origins: a merchant's sentence, or the rule suggester's (the agent pipeline
 * hands its sentence to `draft` with origin agent). Both go through the same author, compiler, validator
 * and dry run; an agent draft additionally never replaces a pending draft or edits a live rule, and is
 * refused when its dry run flags nothing. Every draft carries revenue already lost over its dry-run hits.
 *
 * The agent service is the only writer of rule docs; writes to one rule are serialized here.
 */

export class RuleError extends Error {
  override name = 'RuleError';
  constructor(
    readonly code:
      | 'unknown_tenant'
      | 'invalid_sentence'
      | 'no_probes'
      | 'not_understood'
      | 'author_failed'
      | 'not_found'
      | 'conflict'
      | 'no_hits'
      | 'invalid_probe'
      | 'probe_reads_nothing'
      | 'probe_in_use',
    message: string,
    readonly status: number,
    readonly author: RuleAuthorMeta | null = null,
  ) {
    super(message);
  }
}

export interface RuleServiceDeps {
  state: StateStore;
  warehouse: Warehouse;
  reader: WarehouseReader;
  blob: BlobStore;
  publisher: Publisher;
  signalsTopic: string;
  models: ModelSet;
  logger: Logger;
  tenants: readonly string[];
  dryRun: { sessions: number; days: number };
  rescan: { sessions: number; days: number; concurrency: number };
  /** The revenue-at-risk parameters, for revenue already lost over a draft's dry-run hits. */
  revenue: RevenueParams;
  /** Shoppers the churn watcher suspects: kept out of the revenue baseline like shoppers in an issue. */
  suspected?: (tenantId: string) => ReadonlySet<string>;
  runOptions?: RunOptions;
  now?: () => number;
}

/** A draft written from the rule suggester's or the churn watcher's sentence; omitted for a merchant's. */
export interface AgentDraftOptions {
  origin: 'agent';
  /** The issue whose evidence prompted the suggestion; null when the churn watcher found it in the stream. */
  cluster_id: string | null;
  suggester: RuleAuthorMeta;
  /** Recorded probes the rule needs that are not registered yet (registered when the draft is approved). */
  proposedProbes?: RecordedProbeSpec[];
  /** Churn watcher drafts: the segment it found and the hypothesis. */
  watch?: WatchMeta;
  /** Redraft: replace this rule's pending draft (a person edited the sentence). */
  replaceDraft?: boolean;
}

/** A merchant's draft, optionally naming a recorded probe to register with it. */
export interface HumanDraftOptions {
  origin?: 'human';
  proposedProbes?: RecordedProbeSpec[];
  replaceDraft?: boolean;
}

export { SENTENCE_LIMITS };
const SCAN_CONCURRENCY = 8;
/** The probe catalog the Rules page shows is reused this long (it is read back from raw sessions). */
const CATALOG_TTL_MS = 30_000;
/** Most recent sessions a probe preview reads. */
const PREVIEW_SESSIONS = 300;

/**
 * Why a recorded probe spec cannot be registered, or null. `taken` holds names already used by declared or
 * request probes (a recorded probe may not shadow them).
 */
export function probeSpecProblem(spec: unknown, taken: ReadonlySet<string> = new Set()): string | null {
  const parsed = RecordedProbeSpecSchema.safeParse(spec);
  if (!parsed.success) return 'name must be lowercase letters, digits and _ (starting with a letter), with a selector and a kind (money or count)';
  const s = parsed.data;
  if (s.name.startsWith(REQUEST_PROBE_PREFIX) || isRequestProbe(s.name)) return `names starting with ${REQUEST_PROBE_PREFIX} are reserved for request probes`;
  if (taken.has(s.name)) return `${s.name} is already a probe the store reports; pick another name`;
  if (!compileSelector(s.selector)) return 'the selector uses something outside the supported subset (tag, #id, .class, [attr], [attr="value"], descendant and > combinators)';
  if (s.routes?.some((r) => !r.startsWith('/'))) return 'routes are page paths such as /checkout or /product/:id';
  return null;
}

/** A person's verdict on a draft, as the churn watcher reads it next time. */
function feedbackOf(draft: NonNullable<RuleDoc['draft']>, verdict: RuleFeedback['verdict'], note: string | null, by: string, at: number): RuleFeedback {
  return {
    verdict,
    note: note?.trim() ? note.trim().slice(0, 500) : null,
    by,
    at,
    title: draft.watch?.title ?? draft.rule.title,
    feature_key: draft.watch?.feature.key ?? null,
    churn_reason: draft.watch?.churn_reason ?? null,
    lift: draft.watch?.lift ?? null,
  };
}

/** Whether a rule reads a probe (in what it requires, or anywhere in its two sides). */
export const ruleReads = (rule: InvariantRule, probe: string) => rule.requires.includes(probe) || JSON.stringify(rule.assert).includes(`"${probe}"`);

/** The route most hits were on (ties: alphabetical), for a like-for-like revenue baseline. */
function commonestRoute(routes: Iterable<string>): string {
  const counts = new Map<string, number>();
  for (const r of routes) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
}

export function createRuleService(deps: RuleServiceDeps) {
  const now = deps.now ?? Date.now;
  const chains = new Map<string, Promise<unknown>>();
  const running = new Map<string, Promise<void>>();

  /** Read-modify-write one rule doc, one writer at a time per rule. */
  function update(tenantId: string, ruleId: string, fn: (doc: RuleDoc | null) => RuleDoc | null | Promise<RuleDoc | null>): Promise<RuleDoc | null> {
    const key = `${tenantId}/${ruleId}`;
    const task = async () => {
      const next = await fn(await deps.state.getRule(tenantId, ruleId));
      if (next) await deps.state.putRule(next);
      return next;
    };
    const prev = chains.get(key) ?? Promise.resolve();
    const result = prev.then(task, task);
    chains.set(
      key,
      result.catch(() => undefined),
    );
    return result;
  }

  function requireTenant(tenantId: string): void {
    if (!deps.tenants.includes(tenantId)) throw new RuleError('unknown_tenant', `tenant ${tenantId} is not served by this agent`, 404);
  }

  async function activeRules(tenantId: string): Promise<InvariantRule[]> {
    const docs = await deps.state.listRules(tenantId);
    const tenant = docs.flatMap((d) => (d.active ? [d.active.rule] : []));
    const ids = new Set(tenant.map((r) => r.id));
    return [...BUILTIN_RULES.filter((r) => !ids.has(r.id)), ...tenant];
  }

  async function sessionsInIssues(tenantId: string): Promise<Set<string>> {
    return new Set((await deps.state.listClusters(tenantId, 500)).flatMap((c) => c.sessions));
  }

  /** The tenant's active recorded probes: read from every session a dry run, re-scan or preview reads. */
  async function registeredProbes(tenantId: string): Promise<RecordedProbeSpec[]> {
    return (await deps.state.listProbes(tenantId)).filter((p) => p.status === 'active').map((p) => p.spec);
  }

  /** Registered probes plus proposed ones (a proposal replaces a registered probe of the same name). */
  function withProposed(registry: readonly RecordedProbeSpec[], proposed: readonly RecordedProbeSpec[] = []): RecordedProbeSpec[] {
    const names = new Set(proposed.map((p) => p.name));
    return [...registry.filter((p) => !names.has(p.name)), ...proposed];
  }

  const catalogs = new Map<string, { at: number; catalog: ProbeCatalog; window: { from: number; to: number }; sessions: number }>();

  /** Probes recent sessions report (declared, request and recorded), cached briefly; it is read back from raw. */
  async function recentCatalog(tenantId: string, fresh = false): Promise<{ catalog: ProbeCatalog; window: { from: number; to: number }; sessions: number }> {
    const hit = catalogs.get(tenantId);
    if (!fresh && hit && now() - hit.at < CATALOG_TTL_MS) return hit;
    const t = now();
    const window = { from: t - deps.dryRun.days * 86_400_000, to: t + 1 };
    const sessions: SessionProbes[] = [];
    await scanWindow(deps, {
      tenantId,
      fromMs: window.from,
      toMs: window.to,
      maxSessions: Math.min(deps.dryRun.sessions, PREVIEW_SESSIONS),
      concurrency: SCAN_CONCURRENCY,
      recordedProbes: await registeredProbes(tenantId),
      onSession: (s) => void sessions.push(s),
      onError: (sessionId, err) => deps.logger.warn({ err, tenant_id: tenantId, session_id: sessionId }, 'probe catalog could not read a session; skipped'),
    });
    const entry = { at: t, catalog: buildCatalog(sessions), window, sessions: sessions.length };
    catalogs.set(tenantId, entry);
    return entry;
  }

  /** Names a recorded probe may not take: what sessions already report as declared or request probes. */
  async function takenNames(tenantId: string): Promise<Set<string>> {
    const { catalog } = await recentCatalog(tenantId);
    return new Set(catalog.probes.filter((p) => p.source !== 'recorded').map((p) => p.name));
  }

  /** Register (or re-register) a recorded probe: the hot doc the processor reads, and a `rules` row of kind probe. */
  async function registerProbe(tenantId: string, spec: RecordedProbeSpec, opts: { by: string; source: ProbeDoc['source']; ruleId: string | null; preview: ProbePreview | null }): Promise<ProbeDoc> {
    const existing = await deps.state.getProbe(tenantId, spec.name);
    const same = existing && existing.status === 'active' && JSON.stringify(existing.spec) === JSON.stringify(spec);
    if (same) return existing;
    const t = now();
    const doc: ProbeDoc = {
      v: 1,
      tenant_id: tenantId,
      name: spec.name,
      spec,
      source: opts.source,
      status: 'active',
      version: (existing?.version ?? 0) + 1,
      approved_by: opts.by,
      rule_id: opts.ruleId,
      preview: opts.preview ?? existing?.preview ?? null,
      created_at: existing?.created_at ?? t,
      updated_at: t,
      synthetic: true,
    };
    await deps.warehouse.insert('rules', [
      {
        insertId: `${tenantId}:probe:${spec.name}@${doc.version}`,
        row: { tenant_id: tenantId, rule_id: `probe:${spec.name}`, version: doc.version, kind: 'probe', definition: { type: 'recorded_probe', ...spec, source: opts.source, rule_id: opts.ruleId }, created_by: opts.by, recorded_at: t },
      },
    ]);
    await deps.state.putProbe(doc);
    catalogs.delete(tenantId);
    deps.logger.info({ tenant_id: tenantId, probe: spec.name, version: doc.version, source: opts.source }, 'recorded probe registered');
    return doc;
  }

  function startRescan(tenantId: string, rule: InvariantRule, recordedProbes: readonly RecordedProbeSpec[]): RuleDoc['rescan'] {
    const startedAt = now();
    const rescanId = `rs_${shortHash(`${tenantId}|${ruleVersionOf(rule)}|${startedAt}`, 12)}`;
    const window = { from: startedAt - deps.rescan.days * 86_400_000, to: startedAt + 1 };
    const key = `${tenantId}/${rule.id}`;
    const job = runRescan(deps, {
      tenantId,
      rule,
      rescanId,
      window,
      maxSessions: deps.rescan.sessions,
      concurrency: deps.rescan.concurrency,
      recordedProbes,
      onProgress: async (status) => {
        // Only this re-scan's own status is written; a newer one owns the doc's slot.
        await update(tenantId, rule.id, (doc) => (doc && doc.rescan?.rescan_id === rescanId ? { ...doc, rescan: status, updated_at: now() } : null));
      },
    })
      .then(() => undefined)
      .catch((err: unknown) => deps.logger.error({ err, tenant_id: tenantId, rescan_id: rescanId }, 're-scan crashed'))
      .finally(() => running.delete(key));
    running.set(key, job);
    return initialStatus({ rescanId, rule, window }, startedAt);
  }

  return {
    /**
     * Draft a rule from one sentence, with a dry run. Nothing reaches live traffic until approve. A
     * merchant's sentence by default; `opts` marks a sentence from the rule suggester.
     */
    async draft(tenantId: string, rawSentence: string, opts?: AgentDraftOptions | HumanDraftOptions): Promise<RuleDoc> {
      requireTenant(tenantId);
      const sentence = rawSentence.trim().replace(/\s+/g, ' ');
      if (sentence.length < SENTENCE_LIMITS.min || sentence.length > SENTENCE_LIMITS.max) {
        throw new RuleError('invalid_sentence', `describe the rule in ${SENTENCE_LIMITS.min} to ${SENTENCE_LIMITS.max} characters`, 400);
      }
      const registry = await registeredProbes(tenantId);
      const registered = new Set(registry.map((p) => JSON.stringify(p)));
      // Proposed probes that are already registered as they are need no registration on approval.
      const proposed = (opts?.proposedProbes ?? []).filter((p) => !registered.has(JSON.stringify(p)));
      if (proposed.length > 0) {
        const taken = await takenNames(tenantId);
        for (const p of proposed) {
          const problem = probeSpecProblem(p, taken);
          if (problem) throw new RuleError('invalid_probe', `proposed probe ${p.name}: ${problem}`, 400);
        }
      }
      const startedAt = now();
      const window = { from: startedAt - deps.dryRun.days * 86_400_000, to: startedAt + 1 };
      const sessions: SessionProbes[] = [];
      const scan = await scanWindow(deps, {
        tenantId,
        fromMs: window.from,
        toMs: window.to,
        maxSessions: deps.dryRun.sessions,
        concurrency: SCAN_CONCURRENCY,
        recordedProbes: withProposed(registry, proposed),
        onSession: (s) => void sessions.push(s),
        onError: (sessionId, err) => deps.logger.warn({ err, tenant_id: tenantId, session_id: sessionId }, 'dry run could not read a session; skipped'),
      });
      const catalog = buildCatalog(sessions);
      if (catalog.probes.length === 0) {
        throw new RuleError('no_probes', `no probe values were recorded in the last ${deps.dryRun.days} days, so there is nothing a rule could check yet`, 422);
      }

      const existing = await activeRules(tenantId);
      const { input, evidence } = ruleAuthorInput(sentence, catalog, existing);
      const ctx = { probes: new Set(catalog.probes.map((p) => p.name)), routes: new Set(catalog.routes), evidenceIds: evidence.all, reservedIds: new Set(BUILTIN_RULES.map((r) => r.id)) };
      const result = await runStructured(RULE_AUTHOR, deps.models.reasoning, input, (o) => validateRuleAuthor(o, ctx), deps.runOptions);
      const out = result.output;
      const author: RuleAuthorMeta = {
        model: result.run.model,
        prompt_hash: result.run.prompt_hash,
        offline: result.run.model === OFFLINE_MODEL_ID,
        explanation: out?.explanation.text ?? '',
        evidence_ids: out?.explanation.evidence_ids ?? [],
        assumptions: out?.assumptions ?? [],
        attempts: result.run.attempts,
        ms: result.run.ms,
      };
      const log = deps.logger.child({ tenant_id: tenantId });
      if (!out) {
        log.warn({ model: author.model, attempts: author.attempts, error: result.run.error }, 'rule author output rejected; no draft');
        throw new RuleError('author_failed', `the rule author could not produce a valid rule: ${result.run.error ?? 'no answer'}`, 502, author);
      }
      if (!out.understood) throw new RuleError('not_understood', out.explanation.text || 'the sentence could not be expressed over the recorded probes', 422, author);

      const agent = opts?.origin === 'agent' ? (opts as AgentDraftOptions) : null;
      const issueSessions = await sessionsInIssues(tenantId);
      const suspected = deps.suspected?.(tenantId);
      const notBaseline = suspected?.size ? new Set([...issueSessions, ...suspected]) : issueSessions;
      const outcomes = await deps.reader.sessionOutcomes(tenantId, window.from);
      const unchanged: { doc?: RuleDoc } = {};
      const written = await update(tenantId, out.rule_id, (doc) => {
        if (agent && doc && !opts?.replaceDraft) {
          // The same issue's own pending suggestion: nothing to do (idempotent, so the caller records drafted).
          if (doc.draft?.origin === 'agent' && doc.draft.cluster_id === agent.cluster_id) {
            unchanged.doc = doc;
            return null;
          }
          // Any other doc for this rule id: an agent never replaces a pending draft, never edits a live rule,
          // and never re-proposes a rule a person discarded (reject leaves the doc with no draft and no active).
          throw new RuleError(
            'conflict',
            `rule ${out.rule_id} already has a pending draft, is live, or was discarded by a person before; a suggestion never replaces, edits, or re-proposes it`,
            409,
            author,
          );
        }
        const version = (doc?.active?.rule.version ?? 0) + 1;
        const rule = compileRule(out, version);
        const t = now();
        const hits = new Map<string, string>();
        const preview = dryRun({ tenantId, rule, sessions, window, inIssues: issueSessions, truncated: scan.truncated, now: t, startedAt, onHit: (sessionId, route) => void hits.set(sessionId, route) });
        // A suggested rule that flags nothing in the window is noise, not a finding.
        if (agent && preview.sessions_hit === 0) {
          throw new RuleError('no_hits', `the suggested rule flags none of the ${preview.sessions_scanned} sessions of the last ${deps.dryRun.days} days, so it was not drafted`, 422, author);
        }
        // Revenue already lost: the one revenue-at-risk formula, over the dry run's hit sessions.
        const revenueLost: RevenueAtRisk | null =
          hits.size > 0
            ? revenueAtRisk(
                { affectedSessionIds: [...hits.keys()], affectedSessionCount: hits.size, route: commonestRoute(hits.values()), sessionsInAnyIssue: notBaseline, outcomes, now: t },
                deps.revenue,
              )
            : null;
        log.info(
          {
            rule_version: ruleVersionOf(rule),
            origin: agent ? 'agent' : 'human',
            model: author.model,
            attempts: author.attempts,
            sessions: preview.sessions_scanned,
            applicable: preview.sessions_applicable,
            hit: preview.sessions_hit,
            revenue_lost_minor: revenueLost?.revenue_at_risk_minor ?? null,
            revenue_lost_status: revenueLost?.status ?? null,
          },
          'rule drafted',
        );
        return {
          v: 1,
          tenant_id: tenantId,
          rule_id: rule.id,
          title: doc?.active ? doc.title : rule.title,
          active: doc?.active ?? null,
          draft: {
            rule,
            sentence,
            author,
            dry_run: preview,
            created_at: t,
            origin: agent ? 'agent' : 'human',
            cluster_id: agent?.cluster_id ?? null,
            suggester: agent?.suggester ?? null,
            revenue_lost: revenueLost,
            // Only probes the compiled rule actually reads need registering with it.
            ...(proposed.some((p) => ruleReads(rule, p.name)) ? { proposed_probes: proposed.filter((p) => ruleReads(rule, p.name)) } : {}),
            ...(agent?.watch ? { watch: agent.watch } : {}),
          },
          rescan: doc?.rescan ?? null,
          versions: doc?.versions ?? [],
          ...(doc?.feedback ? { feedback: doc.feedback } : {}),
          created_at: doc?.created_at ?? t,
          updated_at: t,
          synthetic: true,
        };
      });
      return (written ?? unchanged.doc)!;
    },

    /** Approve the pending draft (by version): record it, run it live, and re-scan history with it. */
    async approve(tenantId: string, ruleId: string, version: number, approvedBy: string): Promise<RuleDoc> {
      requireTenant(tenantId);
      const approved: { rule?: InvariantRule } = {};
      const doc = await update(tenantId, ruleId, async (current) => {
        if (!current) throw new RuleError('not_found', `no rule ${ruleId}`, 404);
        const draft = current.draft;
        if (!draft) {
          if (current.active?.rule.version === version) return null; // approved already (a retried click)
          throw new RuleError('not_found', `rule ${ruleId} has no draft to approve`, 404);
        }
        if (draft.rule.version !== version) throw new RuleError('conflict', `the draft is version ${draft.rule.version}, not ${version}; reload and review it`, 409);
        if (running.has(`${tenantId}/${ruleId}`)) throw new RuleError('conflict', 'a re-scan of this rule is still running; approve when it finishes', 409);
        // The probes the rule reads come first: once registered, live traffic and the re-scan both read them.
        for (const spec of draft.proposed_probes ?? []) {
          await registerProbe(tenantId, spec, { by: approvedBy, source: draft.origin === 'agent' ? 'agent' : 'merchant', ruleId: draft.rule.id, preview: null });
        }
        const t = now();
        await deps.warehouse.insert('rules', [
          {
            insertId: `${tenantId}:invariant:${ruleVersionOf(draft.rule)}`,
            row: {
              tenant_id: tenantId,
              rule_id: draft.rule.id,
              version: draft.rule.version,
              kind: 'generated',
              definition: {
                type: 'invariant',
                ...draft.rule,
                sentence: draft.sentence,
                author: { model: draft.author.model, prompt_hash: draft.author.prompt_hash, offline: draft.author.offline },
                dry_run: draft.dry_run
                  ? { sessions_scanned: draft.dry_run.sessions_scanned, sessions_applicable: draft.dry_run.sessions_applicable, sessions_hit: draft.dry_run.sessions_hit, hit_rate: draft.dry_run.hit_rate }
                  : null,
                approved_by: approvedBy,
                ...(draft.proposed_probes?.length ? { probes: draft.proposed_probes.map((p) => p.name) } : {}),
              },
              created_by: approvedBy,
              recorded_at: t,
            },
          },
        ]);
        approved.rule = draft.rule;
        return {
          ...current,
          title: draft.rule.title,
          active: { rule: draft.rule, sentence: draft.sentence, author: draft.author, approved_at: t, approved_by: approvedBy },
          draft: null,
          rescan: startRescan(tenantId, draft.rule, await registeredProbes(tenantId)),
          versions: [...current.versions, { version: draft.rule.version, approved_at: t }],
          feedback: [...(current.feedback ?? []), feedbackOf(draft, 'approved', null, approvedBy, t)],
          updated_at: t,
        };
      });
      if (approved.rule) deps.logger.info({ tenant_id: tenantId, rule_version: ruleVersionOf(approved.rule), approved_by: approvedBy }, 'rule approved; re-scan started');
      return doc ?? (await deps.state.getRule(tenantId, ruleId))!;
    },

    /**
     * Undo an approval: switch the live rule off. Live traffic stops using it within the processor's cache time.
     * Nothing is erased: the signals it already raised and its re-scan stay as history, and the warehouse gets a
     * new row recording the undo (never an update in place).
     */
    async undo(tenantId: string, ruleId: string, by = 'merchant'): Promise<RuleDoc> {
      requireTenant(tenantId);
      const undone: { version?: number } = {};
      const doc = await update(tenantId, ruleId, async (current) => {
        if (!current) throw new RuleError('not_found', `no rule ${ruleId}`, 404);
        const active = current.active;
        if (!active) return null; // already off (a retried click)
        if (running.has(`${tenantId}/${ruleId}`)) throw new RuleError('conflict', 'a re-scan of this rule is still running; undo when it finishes', 409);
        const t = now();
        await deps.warehouse.insert('rules', [
          {
            insertId: `${tenantId}:invariant:${ruleVersionOf(active.rule)}:undone`,
            row: {
              tenant_id: tenantId,
              rule_id: ruleId,
              version: active.rule.version,
              kind: 'generated',
              definition: { type: 'invariant_undone', rule_id: ruleId, version: active.rule.version, undone_by: by },
              created_by: by,
              recorded_at: t,
            },
          },
        ]);
        undone.version = active.rule.version;
        return { ...current, active: null, undone: [...(current.undone ?? []), { version: active.rule.version, undone_at: t, undone_by: by }], updated_at: t };
      });
      if (undone.version !== undefined) deps.logger.info({ tenant_id: tenantId, rule_id: ruleId, rule_version: undone.version, undone_by: by }, 'rule undone; no longer live');
      return doc ?? (await deps.state.getRule(tenantId, ruleId))!;
    },

    /**
     * Discard the pending draft, with an optional note on why. The verdict stays on the doc: the churn watcher
     * does not raise the same number again unless it grows, and the analyst reads the note next time.
     */
    async reject(tenantId: string, ruleId: string, by = 'merchant', note: string | null = null): Promise<RuleDoc> {
      requireTenant(tenantId);
      const doc = await update(tenantId, ruleId, (current) => {
        if (!current) throw new RuleError('not_found', `no rule ${ruleId}`, 404);
        const t = now();
        const feedback = current.draft ? [...(current.feedback ?? []), feedbackOf(current.draft, 'rejected', note, by, t)] : current.feedback;
        return { ...current, draft: null, ...(feedback ? { feedback } : {}), updated_at: t };
      });
      return doc!;
    },

    /**
     * Change the rule: draft again from an edited sentence, keeping the draft's origin, its proposed probes and
     * the watcher's hypothesis. When the new sentence names a different rule, the old draft is cleared.
     */
    async redraft(tenantId: string, ruleId: string, sentence: string): Promise<RuleDoc> {
      requireTenant(tenantId);
      const current = await deps.state.getRule(tenantId, ruleId);
      const d = current?.draft;
      if (!d) throw new RuleError('not_found', `rule ${ruleId} has no draft to change`, 404);
      const opts: AgentDraftOptions | HumanDraftOptions =
        d.origin === 'agent'
          ? { origin: 'agent', cluster_id: d.cluster_id, suggester: d.suggester ?? d.author, replaceDraft: true, ...(d.proposed_probes ? { proposedProbes: d.proposed_probes } : {}), ...(d.watch ? { watch: d.watch } : {}) }
          : { origin: 'human', replaceDraft: true, ...(d.proposed_probes ? { proposedProbes: d.proposed_probes } : {}) };
      const next = await this.draft(tenantId, sentence, opts);
      if (next.rule_id !== ruleId) await update(tenantId, ruleId, (doc) => (doc?.draft ? { ...doc, draft: null, updated_at: now() } : null));
      return next;
    },

    /** Re-scan history with the approved version again (for example after an interrupted run). */
    async rescan(tenantId: string, ruleId: string): Promise<RuleDoc> {
      requireTenant(tenantId);
      const registry = await registeredProbes(tenantId);
      const doc = await update(tenantId, ruleId, (current) => {
        if (!current?.active) throw new RuleError('not_found', `rule ${ruleId} has no approved version`, 404);
        if (running.has(`${tenantId}/${ruleId}`)) throw new RuleError('conflict', 'a re-scan of this rule is already running', 409);
        return { ...current, rescan: startRescan(tenantId, current.active.rule, registry), updated_at: now() };
      });
      return doc!;
    },

    /** At startup: a re-scan left running by a previous process cannot resume; mark it so it can be re-run. */
    async markInterrupted(): Promise<number> {
      let n = 0;
      for (const tenant of deps.tenants) {
        for (const doc of await deps.state.listRules(tenant)) {
          if (doc.rescan?.status !== 'running' || running.has(`${tenant}/${doc.rule_id}`)) continue;
          await update(tenant, doc.rule_id, (d) => (d?.rescan?.status === 'running' ? { ...d, rescan: { ...d.rescan, status: 'interrupted', finished_at: now(), error: 'the agent restarted during the re-scan; run it again' }, updated_at: now() } : null));
          n += 1;
        }
      }
      return n;
    },

    /** The rules the processor runs for a tenant: built-ins (unless replaced) plus every approved tenant rule. */
    activeRules,

    /**
     * Probe statistics over the given sessions (the rule suggester's view of one issue): each session's
     * chunks read back from raw (one per seq, the first ingested) and normalized as the dry run does, then
     * summarized into the catalog. Numbers only; a session that cannot be read is skipped.
     */
    async probeStats(tenantId: string, sessionIds: readonly string[]): Promise<ProbeCatalog> {
      requireTenant(tenantId);
      const since = now() - deps.dryRun.days * 86_400_000;
      const recordedProbes = await registeredProbes(tenantId);
      const read: (SessionProbes | null)[] = sessionIds.map(() => null);
      let next = 0;
      const worker = async () => {
        for (let i = next++; i < sessionIds.length; i = next++) {
          const sessionId = sessionIds[i]!;
          try {
            const bySeq = new Map<number, RawChunkRow>();
            for (const row of await deps.reader.rawChunks(tenantId, sessionId, since)) {
              const seen = bySeq.get(row.seq);
              if (!seen || row.ingest_time < seen.ingest_time) bySeq.set(row.seq, row);
            }
            if (bySeq.size > 0) read[i] = await sessionProbes(deps.blob, tenantId, sessionId, [...bySeq.values()], { recordedProbes });
          } catch (err) {
            deps.logger.warn({ err, tenant_id: tenantId, session_id: sessionId }, 'probe statistics could not read a session; skipped');
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(SCAN_CONCURRENCY, sessionIds.length)) }, worker));
      return buildCatalog(read.filter((s): s is SessionProbes => s !== null));
    },

    /**
     * Every probe the store's recent sessions report, by source (declared in the site's SDK setup, request,
     * recorded), with ranges, plus the registered recorded probes (active or disabled). Numbers only.
     */
    async listProbes(tenantId: string): Promise<{ catalog: ProbeCatalog; registry: ProbeDoc[]; window: { from: number; to: number }; sessions: number }> {
      requireTenant(tenantId);
      const { catalog, window, sessions } = await recentCatalog(tenantId);
      return { catalog, registry: await deps.state.listProbes(tenantId), window, sessions };
    },

    /** What a recorded probe would read over recent sessions, before anyone saves it. Writes nothing. */
    async previewProbe(tenantId: string, spec: RecordedProbeSpec): Promise<ProbePreview> {
      requireTenant(tenantId);
      const problem = probeSpecProblem(spec, await takenNames(tenantId));
      if (problem) throw new RuleError('invalid_probe', problem, 400);
      const t = now();
      const window = { from: t - deps.dryRun.days * 86_400_000, to: t + 1 };
      const sessions: SessionProbes[] = [];
      await scanWindow(deps, {
        tenantId,
        fromMs: window.from,
        toMs: window.to,
        maxSessions: Math.min(deps.dryRun.sessions, PREVIEW_SESSIONS),
        concurrency: SCAN_CONCURRENCY,
        recordedProbes: [spec],
        onSession: (s) => void sessions.push(s),
        onError: (sessionId, err) => deps.logger.warn({ err, tenant_id: tenantId, session_id: sessionId }, 'probe preview could not read a session; skipped'),
      });
      return previewProbe(spec.name, sessions, window, now());
    },

    /**
     * Register a recorded probe a merchant added on the Rules tab. It must read something in recent sessions
     * (a selector that matches nothing is almost always a typo). Live traffic reads it within the processor's
     * cache time, and rules can use it at once.
     */
    async addProbe(tenantId: string, spec: RecordedProbeSpec, by: string): Promise<ProbeDoc> {
      const preview = await this.previewProbe(tenantId, spec);
      if (preview.sessions_with_value === 0) {
        throw new RuleError('probe_reads_nothing', `${spec.selector} matched no number in the last ${preview.sessions_scanned} sessions${spec.routes?.length ? ` on ${spec.routes.join(', ')}` : ''}; check the selector and the page`, 422);
      }
      return registerProbe(tenantId, RecordedProbeSpecSchema.parse(spec), { by, source: 'merchant', ruleId: null, preview });
    },

    /** Stop reading a recorded probe. Refused while an approved rule reads it. */
    async disableProbe(tenantId: string, name: string, by: string): Promise<ProbeDoc> {
      requireTenant(tenantId);
      const doc = await deps.state.getProbe(tenantId, name);
      if (!doc) throw new RuleError('not_found', `no recorded probe ${name}`, 404);
      const users = (await deps.state.listRules(tenantId)).filter((r) => r.active && ruleReads(r.active.rule, name));
      if (users.length > 0) throw new RuleError('probe_in_use', `${name} is read by ${users.map((r) => r.rule_id).join(', ')}; discard those rules first`, 409);
      if (doc.status === 'disabled') return doc;
      const next: ProbeDoc = { ...doc, status: 'disabled', approved_by: by, updated_at: now() };
      await deps.state.putProbe(next);
      catalogs.delete(tenantId);
      return next;
    },

    /** Resolves when every re-scan started so far has finished (tests, shutdown). */
    async idle(): Promise<void> {
      while (running.size > 0) await Promise.all([...running.values()]);
      await Promise.all([...chains.values()]);
    },
  };
}

export type RuleService = ReturnType<typeof createRuleService>;
