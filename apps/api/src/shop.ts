import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from '@cp/logger';
import { registerDemoStore } from './demo-store.js';
import { registerStatic } from './gate.js';

/**
 * The deployed demo shop: the built shop files plus its synthetic backend (`/api/*`), and nothing else. It has no
 * login because it holds no data: no findings, no sessions, no replays. Bugs are switched on in the URL
 * (`?bugs=dead_button,shipping_shock`). Run it with API_MODE=shop.
 */
export function buildShop(deps: { logger: Logger; staticDir: string }): FastifyInstance {
  const app = Fastify({ loggerInstance: deps.logger as FastifyBaseLogger, logController: new LogController({ disableRequestLogging: true }) });
  app.get('/healthz', async () => ({ ok: true, service: 'shop' }));
  registerDemoStore(app, {});
  registerStatic(app, deps.staticDir);
  return app;
}
