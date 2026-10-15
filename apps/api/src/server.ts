import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Logger } from '@cp/logger';
import { loadReplay, SessionTooLongError, type BlobStore, type ReplayPayload, type StateStore, type WarehouseReader } from '@cp/platform';
import { DEMO_BUGS, isDemoBug, type DemoBugStore } from './demo-bugs.js';
import { registerHistoryRoute } from './history.js';
import { DEFAULT_AGENT_URL, registerRuleRoutes, type RuleRouteDeps } from './rules.js';
import { compareFindings, SAFE_ID, TENANT_ID, type Finding, type FindingSummary } from '@cp/schema';

export interface ApiDeps {
  logger: Logger;
  reader: WarehouseReader;
  blob: BlobStore;
  /** The live issues feed (clusters) lives in the state store. */
  state: StateStore;
  defaultTenant: string;
  /** Local mode only: which bugs the demo shop has switched on. Absent on GCP, which hides the routes. */
  demoBugs?: DemoBugStore;
  /** Where rule actions are forwarded (the agent service); the local agent when absent. */
  rules?: Omit<RuleRouteDeps, 'state' | 'defaultTenant'>;
  signalsLookbackMs: number;
  replayLookbackMs: number;
  maxReplayChunks: number;
  now?: () => number;
}

const SignalsQuery = z.object({
  tenant: z.string().regex(TENANT_ID).optional(),
  session: z.string().regex(SAFE_ID).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const ReplayParams = z.object({ id: z.string().regex(SAFE_ID) });
const ReplayQuery = z.object({ tenant: z.string().regex(TENANT_ID).optional() });

const ClustersQuery = z.object({
  tenant: z.string().regex(TENANT_ID).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const ClusterParams = z.object({ id: z.string().regex(/^[0-9a-f]{20}$/) });
const FindingsQuery = z.object({
  tenant: z.string().regex(TENANT_ID).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
const DemoBugsBody = z.object({ bugs: z.array(z.string()).max(DEMO_BUGS.length) });
const TenantQuery = z.object({ tenant: z.string().regex(TENANT_ID).optional() });

/** The feed leaves out the evidence pack and the run log; the detail endpoint has both. */
function summarize(f: Finding): FindingSummary {
  const { evidence: _e, runs: _r, ...rest } = f;
  return rest;
}
const ClusterQuery = z.object({
  tenant: z.string().regex(TENANT_ID).optional(),
  /** How many affected sessions to list, newest first (the cluster keeps up to 5000). */
  sessions: z.coerce.number().int().min(0).max(5000).default(200),
});

/**
 * Read API for the dashboard. Local only for now: it binds to loopback and has no authentication.
 * Phase 3 adds auth and short-lived signed replay URLs before it is deployed.
 */
export function buildApi(deps: ApiDeps): FastifyInstance {
  const now = deps.now ?? Date.now;
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.addHook('onResponse', (req, reply, done) => {
    const fields = { method: req.method, path: req.url.split('?')[0], status: reply.statusCode, ms: Math.round(reply.elapsedTime) };
    if (reply.statusCode >= 500) req.log.error(fields, 'request failed');
    else if (reply.statusCode >= 400) req.log.warn(fields, 'request rejected');
    done();
  });

  app.get('/healthz', async () => ({ ok: true, service: 'api' }));

  // Demo shop bug switches (local mode only). The dashboard writes them, the shop reads them.
  const demoBugs = deps.demoBugs;
  if (demoBugs) {
    const view = (live: readonly string[]) => ({ bugs: live, known: DEMO_BUGS, synthetic: true });
    app.get('/v1/demo/bugs', async (_req, reply) => reply.header('cache-control', 'no-store').send(view(demoBugs.read())));
    app.put('/v1/demo/bugs', async (req, reply) => {
      const body = DemoBugsBody.safeParse(req.body);
      if (!body.success || !body.data.bugs.every(isDemoBug)) return reply.code(400).send({ error: 'invalid_bugs' });
      return reply.header('cache-control', 'no-store').send(view(demoBugs.write(body.data.bugs.filter(isDemoBug))));
    });
  }

  app.get('/v1/signals', async (req, reply) => {
    const q = SignalsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_query' });
    const tenant = q.data.tenant ?? deps.defaultTenant;
    const signals = await deps.reader.signals({
      tenantId: tenant,
      sinceMs: now() - deps.signalsLookbackMs,
      limit: q.data.limit,
      ...(q.data.session ? { sessionId: q.data.session } : {}),
    });
    return { tenant, signals, synthetic: true };
  });

  // The live issues feed: one entry per cluster, most recently active first.
  app.get('/v1/clusters', async (req, reply) => {
    const q = ClustersQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_query' });
    const tenant = q.data.tenant ?? deps.defaultTenant;
    const clusters = await deps.state.listClusters(tenant, q.data.limit);
    // The feed shows counts; session lists stay on the detail endpoint.
    return reply.header('cache-control', 'no-store').send({ tenant, clusters: clusters.map(({ sessions: _s, ...c }) => c), synthetic: true });
  });

  app.get('/v1/clusters/:id', async (req, reply) => {
    const p = ClusterParams.safeParse(req.params);
    const q = ClusterQuery.safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: 'invalid_request' });
    const tenant = q.data.tenant ?? deps.defaultTenant;
    const cluster = await deps.state.getCluster(tenant, p.data.id);
    if (!cluster) return reply.code(404).send({ error: 'cluster_not_found' });
    const sessions = q.data.sessions === 0 ? [] : cluster.sessions.slice(-q.data.sessions).reverse();
    return reply.header('cache-control', 'no-store').send({ cluster: { ...cluster, sessions }, synthetic: true });
  });

  // Ranked findings (the agent service's hot copy): most urgent tier first, then score.
  app.get('/v1/findings', async (req, reply) => {
    const q = FindingsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_query' });
    const tenant = q.data.tenant ?? deps.defaultTenant;
    const findings = (await deps.state.listFindings(tenant, 200)).sort(compareFindings).slice(0, q.data.limit);
    return reply.header('cache-control', 'no-store').send({ tenant, findings: findings.map(summarize), synthetic: true });
  });

  // One finding with its evidence pack, agent runs, and every stored version (bitemporal history).
  app.get('/v1/findings/:id', async (req, reply) => {
    const p = ClusterParams.safeParse(req.params);
    const q = TenantQuery.safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: 'invalid_request' });
    const tenant = q.data.tenant ?? deps.defaultTenant;
    const finding = await deps.state.getFinding(tenant, p.data.id);
    if (!finding) return reply.code(404).send({ error: 'finding_not_found' });
    const rows = await deps.reader.findingVersions(tenant, p.data.id, Math.min(finding.first_seen, now() - deps.replayLookbackMs));
    const versions = rows.map((r) => ({
      version: typeof r.details?.version === 'number' ? r.details.version : null,
      recorded_from: r.recorded_from,
      recorded_to: r.recorded_to,
      tier: r.severity,
      status: r.status,
      score: r.score,
      revenue_at_risk_minor: r.revenue_at_risk_minor,
      currency: r.currency,
      affected_sessions: r.affected_sessions,
      title: r.title,
      model_version: r.model_version,
      prompt_hash: r.prompt_hash,
      rule_version: r.rule_version,
    }));
    return reply.header('cache-control', 'no-store').send({ finding, versions, synthetic: true });
  });

  // The frame the visual check looked at, rendered from the masked replay.
  app.get('/v1/findings/:id/screenshot', async (req, reply) => {
    const p = ClusterParams.safeParse(req.params);
    const q = TenantQuery.safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: 'invalid_request' });
    const tenant = q.data.tenant ?? deps.defaultTenant;
    const finding = await deps.state.getFinding(tenant, p.data.id);
    const uri = finding?.screenshot?.uri;
    if (!uri) return reply.code(404).send({ error: 'screenshot_not_found' });
    if (!uri.includes(`/screenshots/${tenant}/${p.data.id}/`)) return reply.code(404).send({ error: 'screenshot_not_found' });
    const png = await deps.blob.get(uri);
    return reply.header('cache-control', 'no-store').type('image/png').send(png);
  });

  // Phase 4: tenant rules (reads here, actions forwarded to the agent) and time travel over findings.
  registerRuleRoutes(app, { state: deps.state, defaultTenant: deps.defaultTenant, agentUrl: DEFAULT_AGENT_URL, ...deps.rules });
  registerHistoryRoute(app, { reader: deps.reader, state: deps.state, defaultTenant: deps.defaultTenant, lookbackMs: deps.replayLookbackMs, now });

  app.get('/v1/sessions/:id/replay', async (req, reply) => {
    const p = ReplayParams.safeParse(req.params);
    const q = ReplayQuery.safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: 'invalid_request' });
    const tenant = q.data.tenant ?? deps.defaultTenant;
    const sessionId = p.data.id;
    const started = now();

    let payload: ReplayPayload | null;
    try {
      payload = await loadReplay(deps, tenant, sessionId, { sinceMs: now() - deps.replayLookbackMs, maxChunks: deps.maxReplayChunks });
    } catch (err) {
      if (err instanceof SessionTooLongError) return reply.code(413).send({ error: 'session_too_long', chunks: err.chunks });
      throw err;
    }
    if (!payload) return reply.code(404).send({ error: 'session_not_found' });
    req.log.info(
      { tenant_id: tenant, session_id: sessionId, chunks: payload.session.chunks, event_count: payload.events.length, markers: payload.markers.length, ms: now() - started },
      'replay served',
    );
    // Replays hold (scrubbed) session content: never cache them.
    return reply.header('cache-control', 'no-store').send(payload);
  });

  return app;
}
