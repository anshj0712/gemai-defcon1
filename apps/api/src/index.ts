import { z } from 'zod';
import { createLogger, flushLogs } from '@cp/logger';
import { createPlatform, loadDotEnv, loadPlatformConfig, parseEnv } from '@cp/platform';
import { TENANT_ID } from '@cp/schema';
import { buildApi } from './server.js';

const ApiEnv = z.object({
  API_PORT: z.coerce.number().int().min(1).default(8082),
  // Local only until Phase 3 adds authentication: loopback unless explicitly overridden.
  API_HOST: z.string().default('127.0.0.1'),
  API_DEFAULT_TENANT: z.string().regex(TENANT_ID).default('demo'),
  SIGNALS_LOOKBACK_DAYS: z.coerce.number().positive().default(7),
  REPLAY_LOOKBACK_DAYS: z.coerce.number().positive().default(31),
  MAX_REPLAY_CHUNKS: z.coerce.number().int().positive().default(1000),
});

async function main(): Promise<void> {
  loadDotEnv();
  const pc = loadPlatformConfig();
  const e = parseEnv(ApiEnv);
  const logger = createLogger({ service: 'api', projectId: pc.projectId });
  const platform = createPlatform(pc, logger);
  const app = buildApi({
    logger,
    reader: platform.reader,
    blob: platform.blob,
    state: platform.state,
    defaultTenant: e.API_DEFAULT_TENANT,
    signalsLookbackMs: e.SIGNALS_LOOKBACK_DAYS * 86_400_000,
    replayLookbackMs: e.REPLAY_LOOKBACK_DAYS * 86_400_000,
    maxReplayChunks: e.MAX_REPLAY_CHUNKS,
  });
  await app.listen({ port: e.API_PORT, host: e.API_HOST });
  logger.info({ mode: pc.mode, port: e.API_PORT, tenant: e.API_DEFAULT_TENANT }, `api ready: http://localhost:${e.API_PORT}/v1/findings`);

  const shutdown = async () => {
    await app.close();
    await platform.close();
    await flushLogs();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch(async (err: unknown) => {
  process.stderr.write(`api failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  await flushLogs();
  process.exit(1);
});
