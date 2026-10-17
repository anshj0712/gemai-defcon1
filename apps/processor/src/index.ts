import { DETECTORS } from '@cp/detectors';
import { createLogger, flushLogs, logsExplorerUrl, resolveLogFormat, serviceLogFilter } from '@cp/logger';
import { createPlatform, loadDotEnv } from '@cp/platform';
import { loadProcessorConfig } from './config.js';
import { createChunkHandler } from './handle-chunk.js';
import { createProbeSource } from './probes.js';
import { createRuleSource } from './rules.js';
import { buildProcessor, deliver } from './server.js';
import { TailCache } from './tail-cache.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadProcessorConfig();
  const { platform: pc } = config;
  const logger = createLogger({ service: 'processor', projectId: pc.projectId });
  const platform = createPlatform(pc, logger);

  const maxWindow = Math.max(0, ...DETECTORS.map((d) => Number(d.params.windowMs ?? 0)));
  if (config.tailLookbackMs < maxWindow) {
    logger.warn({ tail_lookback_ms: config.tailLookbackMs, max_window_ms: maxWindow }, 'TAIL_LOOKBACK_MS is shorter than a detector window; cross-chunk decisions may miss evidence');
  }

  const handler = createChunkHandler({
    blob: platform.blob,
    warehouse: platform.warehouse,
    publisher: platform.publisher,
    state: platform.state,
    tails: new TailCache(platform.state, { ttlMs: config.tailCacheTtlMs, max: config.tailCacheMax, storeTtlMs: config.tailTtlMs }),
    signalsTopic: pc.topics.signals,
    detectors: DETECTORS,
    overrides: config.overrides,
    rulesFor: createRuleSource({ state: platform.state, base: config.rules, ttlMs: config.rulesCacheTtlMs, logger }),
    ...(config.recordedProbes ? { probesFor: createProbeSource({ state: platform.state, ttlMs: config.probesCacheTtlMs, logger }), mirror: true } : {}),
    lookbackMs: config.tailLookbackMs,
    tailMaxEvents: config.tailMaxEvents,
    markerTtlMs: config.markerTtlMs,
    gapWaitAttempts: config.gapWaitAttempts,
    logger,
  });

  const app = buildProcessor({ logger, handler, projectId: pc.projectId });
  await app.listen({ port: config.port, host: config.host });

  const puller = config.pull
    ? platform.pull(pc.subscriptions.eventsRaw, (m) =>
        deliver(handler, m.data, { messageId: m.id, deliveryAttempt: m.deliveryAttempt }, logger),
      )
    : null;

  logger.info(
    {
      mode: pc.mode,
      port: config.port,
      intake: puller ? `pull ${pc.subscriptions.eventsRaw}` : 'push /pubsub/push',
      detectors: DETECTORS.map((d) => `${d.id}@${d.version}`),
      warehouse: pc.mode === 'gcp' ? `bigquery ${pc.projectId}.${pc.dataset}` : `${pc.localDataDir}`,
    },
    'processor ready',
  );
  if (pc.projectId && (resolveLogFormat() === 'gcp' || process.env.LOG_TO_CLOUD === 'true')) {
    logger.info({ url: logsExplorerUrl(pc.projectId, serviceLogFilter(pc.projectId, { service: 'processor' })) }, 'logs in Cloud Logging');
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
  process.stderr.write(`processor failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  await flushLogs();
  process.exit(1);
});
