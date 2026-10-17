import { z } from 'zod';
import { createLogger, flushLogs } from '@cp/logger';
import { createPlatform, loadDotEnv, loadPlatformConfig, parseEnv } from '@cp/platform';
import { TENANT_ID } from '@cp/schema';
import { join } from 'node:path';
import { createFileDemoBugStore } from './demo-bugs.js';
import { DEFAULT_AGENT_URL } from './rules.js';
import { buildApi } from './server.js';

const ApiEnv = z.object({
  API_PORT: z.coerce.number().int().min(1).default(8082),
  // Local only until Phase 3 adds authentication: loopback unless explicitly overridden.
  API_HOST: z.string().default('127.0.0.1'),
  API_DEFAULT_TENANT: z.string().regex(TENANT_ID).default('demo'),
  SIGNALS_LOOKBACK_DAYS: z.coerce.number().positive().default(7),
  REPLAY_LOOKBACK_DAYS: z.coerce.number().positive().default(31),
  MAX_REPLAY_CHUNKS: z.coerce.number().int().positive().default(1000),
  /** The agent service, where rule actions (draft, approve, reject, re-scan) are forwarded. */
  AGENT_URL: z.url().default(DEFAULT_AGENT_URL),
  /** The synthetic shop's backend (`/api/*`): on in local mode; set true to serve it from a deployed API too. */
  DEMO_STORE: z.enum(['true', 'false']).optional(),
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
    // Local mode only: the dashboard switches demo bugs on and off, the shop follows.
    qualityFile: pc.mode === 'local' ? join(pc.localDataDir, 'quality.json') : undefined,
    demoBugs: pc.mode === 'local' ? createFileDemoBugStore(join(pc.localDataDir, 'demo-bugs.json')) : undefined,
    demoStore: (e.DEMO_STORE ?? (pc.mode === 'local' ? 'true' : 'false')) === 'true' ? {} : undefined,
    signalsLookbackMs: e.SIGNALS_LOOKBACK_DAYS * 86_400_000,
    replayLookbackMs: e.REPLAY_LOOKBACK_DAYS * 86_400_000,
    maxReplayChunks: e.MAX_REPLAY_CHUNKS,
    // On Cloud Run (K_SERVICE) the agent is private: call it with an ID token from the metadata server.
    rules: { agentUrl: e.AGENT_URL, agentAuth: process.env.K_SERVICE ? 'metadata' : 'none' },
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
