import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { traceBindings, type Logger } from '@cp/logger';
import { PubSubPushBody, RawChunkMessage } from '@cp/schema';
import { ChunkGapError, PoisonMessageError, type ChunkOutcome, type MessageMeta } from './handle-chunk.js';

export interface ChunkHandler {
  handle(msg: RawChunkMessage, meta?: MessageMeta): Promise<ChunkOutcome>;
}

/**
 * Decode one Pub/Sub message and hand it to the chunk handler.
 * 'ack' for success and for messages that can never succeed (logged as poison); 'nack' to retry.
 */
export async function deliver(handler: ChunkHandler, data: Buffer, meta: MessageMeta, logger: Logger): Promise<'ack' | 'nack'> {
  let msg: RawChunkMessage;
  try {
    msg = RawChunkMessage.parse(JSON.parse(data.toString('utf8')));
  } catch {
    logger.error({ message_id: meta.messageId }, 'poison message: not a RawChunkMessage; acking so it is not redelivered');
    return 'ack';
  }
  try {
    await handler.handle(msg, meta);
    return 'ack';
  } catch (err) {
    const ids = { tenant_id: msg.tenant_id, session_id: msg.session_id, seq: msg.seq, message_id: meta.messageId };
    if (err instanceof PoisonMessageError) {
      logger.error({ ...ids, reason: err.message }, 'poison message; acking so it is not redelivered');
      return 'ack';
    }
    if (err instanceof ChunkGapError) {
      logger.warn({ ...ids, reason: err.message }, 'chunk arrived before an earlier one; asking for redelivery');
      return 'nack';
    }
    logger.error({ err, ...ids, delivery_attempt: meta.deliveryAttempt }, 'chunk processing failed; Pub/Sub will redeliver');
    return 'nack';
  }
}

export function buildProcessor(deps: { logger: Logger; handler: ChunkHandler; projectId?: string | undefined }): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1_000_000,
    childLoggerFactory: (logger, bindings, opts, rawReq) =>
      logger.child({ ...bindings, ...traceBindings(rawReq.headers, deps.projectId) }, opts),
  });

  app.addHook('onResponse', (req, reply, done) => {
    if (reply.statusCode >= 400) {
      req.log.warn({ method: req.method, path: req.url.split('?')[0], status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request not acked');
    }
    done();
  });

  app.get('/healthz', async () => ({ ok: true, service: 'processor' }));

  // Pub/Sub push endpoint. 2xx acks the message; anything else makes Pub/Sub redeliver with backoff.
  app.post('/pubsub/push', async (req, reply) => {
    const body = PubSubPushBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'not_a_pubsub_push' });
    const { message, deliveryAttempt } = body.data;
    const outcome = await deliver(
      deps.handler,
      Buffer.from(message.data, 'base64'),
      { messageId: message.messageId, deliveryAttempt },
      req.log as unknown as Logger,
    );
    return outcome === 'ack' ? reply.code(204).send() : reply.code(500).send({ error: 'retry' });
  });

  return app;
}
