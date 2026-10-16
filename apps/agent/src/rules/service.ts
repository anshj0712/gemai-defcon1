import { BUILTIN_RULES, shortHash } from '@cp/detectors';
import type { Logger } from '@cp/logger';
import type { BlobStore, Publisher, StateStore, Warehouse, WarehouseReader } from '@cp/platform';
import { ruleVersionOf, type InvariantRule, type RawChunkRow, type RevenueAtRisk, type RuleAuthorMeta, type RuleDoc } from '@cp/schema';
import { RULE_AUTHOR, ruleAuthorInput } from '../agents/rule-author.js';
import { SENTENCE_LIMITS } from '../grounding.js';
import type { ModelSet } from '../llm/models.js';
import { OFFLINE_MODEL_ID } from '../llm/offline.js';
import { runStructured, type RunOptions } from '../llm/run-agent.js';
import { revenueAtRisk, type RevenueParams } from '../scoring/revenue.js';
import { compileRule, validateRuleAuthor } from './compile.js';
import { buildCatalog, dryRun, type ProbeCatalog } from './evaluate.js';
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
    readonly code: 'unknown_tenant' | 'invalid_sentence' | 'no_probes' | 'not_understood' | 'author_failed' | 'not_found' | 'conflict' | 'no_hits',
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
  runOptions?: RunOptions;
  now?: () => number;
}

/** A draft written from the rule suggester's sentence (see pipeline.ts); omitted for a merchant's. */
export interface AgentDraftOptions {
  origin: 'agent';
  /** The issue whose evidence prompted the suggestion. */
  cluster_id: string;
  suggester: RuleAuthorMeta;
}

export { SENTENCE_LIMITS };
const SCAN_CONCURRENCY = 8;

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

  function startRescan(tenantId: string, rule: InvariantRule): RuleDoc['rescan'] {
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
    async draft(tenantId: string, rawSentence: string, opts?: AgentDraftOptions): Promise<RuleDoc> {
      requireTenant(tenantId);
      const sentence = rawSentence.trim().replace(/\s+/g, ' ');
      if (sentence.length < SENTENCE_LIMITS.min || sentence.length > SENTENCE_LIMITS.max) {
        throw new RuleError('invalid_sentence', `describe the rule in ${SENTENCE_LIMITS.min} to ${SENTENCE_LIMITS.max} characters`, 400);
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

      const agent = opts?.origin === 'agent' ? opts : null;
      const issueSessions = await sessionsInIssues(tenantId);
      const outcomes = await deps.reader.sessionOutcomes(tenantId, window.from);
      const unchanged: { doc?: RuleDoc } = {};
      const written = await update(tenantId, out.rule_id, (doc) => {
        if (agent && doc) {
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
                { affectedSessionIds: [...hits.keys()], affectedSessionCount: hits.size, route: commonestRoute(hits.values()), sessionsInAnyIssue: issueSessions, outcomes, now: t },
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
          },
          rescan: doc?.rescan ?? null,
          versions: doc?.versions ?? [],
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
          rescan: startRescan(tenantId, draft.rule),
          versions: [...current.versions, { version: draft.rule.version, approved_at: t }],
          updated_at: t,
        };
      });
      if (approved.rule) deps.logger.info({ tenant_id: tenantId, rule_version: ruleVersionOf(approved.rule), approved_by: approvedBy }, 'rule approved; re-scan started');
      return doc ?? (await deps.state.getRule(tenantId, ruleId))!;
    },

    async reject(tenantId: string, ruleId: string): Promise<RuleDoc> {
      requireTenant(tenantId);
      const doc = await update(tenantId, ruleId, (current) => {
        if (!current) throw new RuleError('not_found', `no rule ${ruleId}`, 404);
        return { ...current, draft: null, updated_at: now() };
      });
      return doc!;
    },

    /** Re-scan history with the approved version again (for example after an interrupted run). */
    async rescan(tenantId: string, ruleId: string): Promise<RuleDoc> {
      requireTenant(tenantId);
      const doc = await update(tenantId, ruleId, (current) => {
        if (!current?.active) throw new RuleError('not_found', `rule ${ruleId} has no approved version`, 404);
        if (running.has(`${tenantId}/${ruleId}`)) throw new RuleError('conflict', 'a re-scan of this rule is already running', 409);
        return { ...current, rescan: startRescan(tenantId, current.active.rule), updated_at: now() };
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
            if (bySeq.size > 0) read[i] = await sessionProbes(deps.blob, tenantId, sessionId, [...bySeq.values()]);
          } catch (err) {
            deps.logger.warn({ err, tenant_id: tenantId, session_id: sessionId }, 'probe statistics could not read a session; skipped');
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(SCAN_CONCURRENCY, sessionIds.length)) }, worker));
      return buildCatalog(read.filter((s): s is SessionProbes => s !== null));
    },

    /** Resolves when every re-scan started so far has finished (tests, shutdown). */
    async idle(): Promise<void> {
      while (running.size > 0) await Promise.all([...running.values()]);
      await Promise.all([...chains.values()]);
    },
  };
}

export type RuleService = ReturnType<typeof createRuleService>;
