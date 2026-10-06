import { z } from 'zod';
import { createLogger, flushLogs, logsExplorerUrl, resolveLogFormat, serviceLogFilter } from '@cp/logger';
import { boolEnv, createPlatform, DEFAULT_CLUSTERER_PORT, loadDotEnv, loadPlatformConfig, parseEnv } from '@cp/platform';
import { createClusterer } from './handler.js';
import { buildClusterer, deliverSignal } from './server.js';

const ClustererEnv = z.object({
  PORT: z.coerce.number().int().min(1).default(DEFAULT_CLUSTERER_PORT),
  // Loopback for local runs; all interfaces on Cloud Run (K_SERVICE) or when HOST is set (containers).
  HOST: z.string().default(process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1'),
  /** Pull from the signals subscription instead of waiting for push (local runs against real GCP). */
  CLUSTERER_PULL: boolEnv.default(false),
  MAX_CLUSTERS_PER_TENANT: z.coerce.number().int().positive().default(500),
  CLUSTERED_MARKER_TTL_DAYS: z.coerce.number().positive().default(8),
});

async function main(): Promise<void> {
  loadDotEnv();
  const pc = loadPlatformConfig();
  const e = parseEnv(ClustererEnv);
  const logger = createLogger({ service: 'clusterer', projectId: pc.projectId });
  const platform = createPlatform(pc, logger);
  const handler = createClusterer({
    state: platform.state,
    logger,
    maxClustersPerTenant: e.MAX_CLUSTERS_PER_TENANT,
    markerTtlMs: e.CLUSTERED_MARKER_TTL_DAYS * 86_400_000,
  });

  const app = buildClusterer({ logger, handler, projectId: pc.projectId });
  await app.listen({ port: e.PORT, host: e.HOST });
  const puller = e.CLUSTERER_PULL ? platform.pull(pc.subscriptions.signals, (m) => deliverSignal(handler, m.data, m.id, logger)) : null;

  logger.info(
    { mode: pc.mode, port: e.PORT, intake: puller ? `pull ${pc.subscriptions.signals}` : 'push /pubsub/push', max_clusters_per_tenant: e.MAX_CLUSTERS_PER_TENANT },
    'clusterer ready',
  );
  if (pc.projectId && (resolveLogFormat() === 'gcp' || process.env.LOG_TO_CLOUD === 'true')) {
    logger.info({ url: logsExplorerUrl(pc.projectId, serviceLogFilter(pc.projectId, { service: 'clusterer' })) }, 'logs in Cloud Logging');
  }

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    await puller?.close();
    await app.close();
    await platform.close();
    await flushLogs();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (err: unknown) => {
  process.stderr.write(`clusterer failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  await flushLogs();
  process.exit(1);
});
