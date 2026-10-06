import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { traceBindings, type Logger } from '@cp/logger';
import { PubSubPushBody, SignalRow } from '@cp/schema';
import type { ClusterOutcome } from './handler.js';

export interface SignalHandler {
  apply(row: SignalRow): Promise<ClusterOutcome>;
}

/** Decode one `signals` message and cluster it. 'ack' on success or poison; 'nack' to retry. */
export async function deliverSignal(handler: SignalHandler, data: Buffer, messageId: string | undefined, logger: Logger): Promise<'ack' | 'nack'> {
  let row: SignalRow;
  try {
    row = SignalRow.parse(JSON.parse(data.toString('utf8')));
  } catch {
    logger.error({ message_id: messageId }, 'poison message: not a signal row; acking so it is not redelivered');
    return 'ack';
  }
  try {
    await handler.apply(row);
    return 'ack';
  } catch (err) {
    logger.error({ err, tenant_id: row.tenant_id, signal_id: row.signal_id, message_id: messageId }, 'clustering failed; Pub/Sub will redeliver');
    return 'nack';
  }
}

export function buildClusterer(deps: { logger: Logger; handler: SignalHandler; projectId?: string | undefined }): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1_000_000,
    childLoggerFactory: (logger, bindings, opts, rawReq) => logger.child({ ...bindings, ...traceBindings(rawReq.headers, deps.projectId) }, opts),
  });

  app.addHook('onResponse', (req, reply, done) => {
    if (reply.statusCode >= 400) {
      req.log.warn({ method: req.method, path: req.url.split('?')[0], status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request not acked');
    }
    done();
  });

  app.get('/healthz', async () => ({ ok: true, service: 'clusterer' }));

  // Pub/Sub push endpoint for the `signals` topic. 2xx acks; anything else is redelivered with backoff.
  app.post('/pubsub/push', async (req, reply) => {
    const body = PubSubPushBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'not_a_pubsub_push' });
    const outcome = await deliverSignal(deps.handler, Buffer.from(body.data.message.data, 'base64'), body.data.message.messageId, req.log as unknown as Logger);
    return outcome === 'ack' ? reply.code(204).send() : reply.code(500).send({ error: 'retry' });
  });

  return app;
}
