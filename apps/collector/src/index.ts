import { createLogger, flushLogs, logsExplorerUrl, resolveLogFormat, serviceLogFilter } from '@cp/logger';
import { createPlatform, loadDotEnv } from '@cp/platform';
import { loadCollectorConfig } from './config.js';
import { buildCollector } from './server.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadCollectorConfig();
  const { platform: pc } = config;
  const logger = createLogger({ service: 'collector', projectId: pc.projectId });
  const platform = createPlatform(pc, logger);

  const app = await buildCollector({
    logger,
    blob: platform.blob,
    publisher: platform.publisher,
    topic: pc.topics.eventsRaw,
    siteKeys: config.siteKeys,
    maxBodyBytes: config.maxBodyBytes,
    maxDecompressedBytes: config.maxDecompressedBytes,
    projectId: pc.projectId,
  });
  await app.listen({ port: config.port, host: config.host });

  logger.info(
    {
      mode: pc.mode,
      port: config.port,
      raw_store: pc.mode === 'gcp' ? `gs://${pc.rawBucket}` : `${pc.localDataDir}`,
      topic: pc.topics.eventsRaw,
      tenants: config.siteKeys.size,
    },
    `collector ready: POST http://localhost:${config.port}/v1/ingest`,
  );
  if (config.usingDefaultSiteKeys) logger.warn('SITE_KEYS not set; accepting the local demo key pk_local_demo only');
  if (pc.projectId && (resolveLogFormat() === 'gcp' || process.env.LOG_TO_CLOUD === 'true')) {
    logger.info({ url: logsExplorerUrl(pc.projectId, serviceLogFilter(pc.projectId, { service: 'collector' })) }, 'logs in Cloud Logging');
  }

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    await app.close();
    await platform.close();
    await flushLogs();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (err: unknown) => {
  process.stderr.write(`collector failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  await flushLogs();
  process.exit(1);
});
