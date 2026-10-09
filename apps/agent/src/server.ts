import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { traceBindings, type Logger } from '@cp/logger';
import type { PassResult } from './service.js';

/**
 * HTTP surface of the agent service: health, and POST /run to trigger a pass now (the local timer,
 * or Cloud Scheduler with an OIDC token when deployed, since the service is private).
 */
export function buildAgentServer(deps: { logger: Logger; runPass: () => Promise<PassResult[]>; info: Record<string, unknown>; projectId?: string | undefined }): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    childLoggerFactory: (logger, bindings, opts, rawReq) => logger.child({ ...bindings, ...traceBindings(rawReq.headers, deps.projectId) }, opts),
  });
  app.get('/healthz', async () => ({ ok: true, service: 'agent', ...deps.info }));
  app.post('/run', async () => ({ results: await deps.runPass() }));
  return app;
}
