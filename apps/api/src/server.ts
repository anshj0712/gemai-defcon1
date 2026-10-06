import { gunzipSync } from 'node:zlib';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Logger } from '@cp/logger';
import type { BlobStore, StateStore, WarehouseReader } from '@cp/platform';
import { SAFE_ID, StoredChunk, TENANT_ID } from '@cp/schema';
import { skewBySeq, stitchEvents, toMarkers, type ReplayPayload } from './replay.js';

export interface ApiDeps {
  logger: Logger;
  reader: WarehouseReader;
  blob: BlobStore;
  /** The live issues feed (clusters) lives in the state store. */
  state: StateStore;
  defaultTenant: string;
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

  app.get('/v1/sessions/:id/replay', async (req, reply) => {
    const p = ReplayParams.safeParse(req.params);
    const q = ReplayQuery.safeParse(req.query);
    if (!p.success || !q.success) return reply.code(400).send({ error: 'invalid_request' });
    const tenant = q.data.tenant ?? deps.defaultTenant;
    const sessionId = p.data.id;
    const started = now();

    const rows = await deps.reader.rawChunks(tenant, sessionId, now() - deps.replayLookbackMs);
    if (rows.length === 0) return reply.code(404).send({ error: 'session_not_found' });
    if (rows.length > deps.maxReplayChunks) return reply.code(413).send({ error: 'session_too_long', chunks: rows.length });

    const chunks = await Promise.all(
      rows.map(async (r) => {
        const stored = StoredChunk.parse(JSON.parse(gunzipSync(await deps.blob.get(r.gcs_uri)).toString('utf8')));
        if (stored.tenant_id !== tenant) throw new Error('stored chunk belongs to another tenant');
        return { seq: r.seq, stored };
      }),
    );
    const signals = await deps.reader.signals({ tenantId: tenant, sessionId, sinceMs: now() - deps.replayLookbackMs, limit: 500 });
    const first = rows[0]!;
    const last = rows.at(-1)!;
    const payload: ReplayPayload = {
      session: {
        session_id: sessionId,
        tenant_id: tenant,
        chunks: rows.length,
        release: last.release,
        route: last.route,
        started_at: first.event_time_start,
        ended_at: last.event_time_end,
      },
      events: stitchEvents(chunks),
      markers: toMarkers(signals, skewBySeq(rows)),
    };
    req.log.info(
      { tenant_id: tenant, session_id: sessionId, chunks: rows.length, event_count: payload.events.length, markers: payload.markers.length, ms: now() - started },
      'replay served',
    );
    // Replays hold (scrubbed) session content: never cache them.
    return reply.header('cache-control', 'no-store').send(payload);
  });

  return app;
}
