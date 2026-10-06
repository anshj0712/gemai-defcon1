import { gunzipSync, gzipSync } from 'node:zlib';
import cors from '@fastify/cors';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { traceBindings, type Logger } from '@cp/logger';
import type { BlobStore, Publisher } from '@cp/platform';
import { IngestEnvelope, type RawChunkMessage, type StoredChunk } from '@cp/schema';
import type { SiteKeyMap } from './config.js';
import { nonZero, scrubEnvelope } from './scrub.js';

export interface CollectorDeps {
  logger: Logger;
  blob: BlobStore;
  publisher: Publisher;
  /** Topic for RawChunkMessage (events.raw). */
  topic: string;
  siteKeys: SiteKeyMap;
  maxBodyBytes: number;
  maxDecompressedBytes: number;
  projectId?: string | undefined;
  now?: () => number;
}

/** raw/<tenant>/<session>/<seq, zero padded>.json.gz: per-tenant prefix, lexically ordered by seq. */
export function chunkPath(tenantId: string, sessionId: string, seq: number): string {
  return `raw/${tenantId}/${sessionId}/${String(seq).padStart(8, '0')}.json.gz`;
}

const isGzip = (b: Buffer) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

export async function buildCollector(deps: CollectorDeps): Promise<FastifyInstance> {
  const now = deps.now ?? Date.now;
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: deps.maxBodyBytes,
    trustProxy: true,
    childLoggerFactory: (logger, bindings, opts, rawReq) =>
      logger.child({ ...bindings, ...traceBindings(rawReq.headers, deps.projectId) }, opts),
  });

  // Ingest is called from merchant pages on any origin; the site key (and optional origin list) is the auth.
  await app.register(cors, { origin: true, methods: ['POST', 'OPTIONS'], maxAge: 600 });

  // Bodies are taken raw: gzip or plain JSON, sent by fetch or navigator.sendBeacon with any content type.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.addHook('onResponse', (req, reply, done) => {
    const fields = { method: req.method, path: req.url.split('?')[0], status: reply.statusCode, ms: Math.round(reply.elapsedTime) };
    if (reply.statusCode >= 500) req.log.error(fields, 'request failed');
    else if (reply.statusCode >= 400) req.log.warn(fields, 'request rejected');
    else req.log.debug(fields, 'request');
    done();
  });

  app.get('/healthz', async () => ({ ok: true, service: 'collector' }));

  app.post('/v1/ingest', async (req, reply) => {
    const receivedAt = now();
    const raw = req.body as Buffer | undefined;
    if (!raw || raw.length === 0) return reply.code(400).send({ error: 'empty_body' });

    let text: string;
    try {
      const gz = req.headers['content-encoding'] === 'gzip' || isGzip(raw);
      text = (gz ? gunzipSync(raw, { maxOutputLength: deps.maxDecompressedBytes }) : raw).toString('utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') return reply.code(413).send({ error: 'payload_too_large' });
      return reply.code(400).send({ error: 'bad_gzip' });
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return reply.code(400).send({ error: 'invalid_json' });
    }

    const parsed = IngestEnvelope.safeParse(json);
    if (!parsed.success) {
      // Paths and codes only: zod messages never carry values, but keep the log minimal anyway.
      const issues = parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), code: i.code }));
      req.log.warn({ issues }, 'envelope rejected');
      return reply.code(400).send({ error: 'invalid_envelope', issues });
    }
    const envelope = parsed.data;

    const siteKey = deps.siteKeys.get(envelope.site_key);
    if (!siteKey) {
      req.log.warn({ key_prefix: envelope.site_key.slice(0, 8) }, 'unknown site key');
      return reply.code(401).send({ error: 'unknown_site_key' });
    }
    const origin = req.headers.origin;
    if (siteKey.origins && origin && !siteKey.origins.includes(origin)) {
      req.log.warn({ tenant_id: siteKey.tenantId, origin }, 'origin not allowed for site key');
      return reply.code(403).send({ error: 'origin_not_allowed' });
    }

    const { envelope: scrubbed, stats } = scrubEnvelope(envelope);
    const { site_key: _siteKey, ...stored } = scrubbed;
    const document: StoredChunk = { v: 1, tenant_id: siteKey.tenantId, collector_received_at: receivedAt, envelope: stored };
    const body = gzipSync(JSON.stringify(document));
    const ids = { tenant_id: siteKey.tenantId, session_id: envelope.session_id, seq: envelope.seq };

    try {
      const { uri, created } = await deps.blob.putIfAbsent(chunkPath(ids.tenant_id, ids.session_id, ids.seq), body, 'application/gzip');
      const message: RawChunkMessage = {
        v: 1,
        ...ids,
        gcs_uri: uri,
        bytes: body.length,
        event_count: envelope.events.length,
        client_ts_start: envelope.client_ts_start,
        client_ts_end: envelope.client_ts_end,
        client_sent_at: envelope.client_sent_at,
        collector_received_at: receivedAt,
        release: envelope.release,
        route: scrubbed.page.route,
        sdk_version: envelope.sdk_version,
        ...(envelope.sample_rate !== undefined ? { sample_rate: envelope.sample_rate } : {}),
      };
      // Publish even when the object already existed: an earlier attempt may have stored the chunk
      // and failed to publish. The processor is idempotent on (session_id, seq).
      await deps.publisher.publish(deps.topic, message, {
        orderingKey: ids.session_id,
        attributes: { tenant_id: ids.tenant_id, session_id: ids.session_id, seq: String(ids.seq) },
      });
      req.log.info(
        {
          ...ids,
          event_count: envelope.events.length,
          bytes_in: raw.length,
          bytes_stored: body.length,
          duplicate: !created,
          scrubbed: nonZero(stats),
          ms: now() - receivedAt,
        },
        created ? 'chunk accepted' : 'chunk accepted (already stored; republished)',
      );
      return reply.code(202).send({ ok: true, seq: ids.seq, duplicate: !created });
    } catch (err) {
      req.log.error({ err, ...ids }, 'storing or publishing chunk failed');
      return reply.code(503).send({ error: 'unavailable' });
    }
  });

  return app;
}
