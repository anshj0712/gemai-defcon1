import { createLogger, flushLogs } from '@cp/logger';
import { createPlatform, loadDotEnv, loadPlatformConfig } from '@cp/platform';
import { RULE_ID, TENANT_ID } from '@cp/schema';
import { loadAgentConfig } from './config.js';
import { OfflineLlm } from './llm/offline.js';
import { createRuleService } from './rules/service.js';

/**
 * `pnpm rescan -- --tenant demo --rule <rule_id>`: re-scan history with a rule's approved version, the
 * same code the agent runs after an approval. This is the command a Cloud Run Job runs for large
 * windows (ARCHITECTURE.md section 10). Settings come from the environment (RESCAN_*), as in the agent.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadDotEnv();
  const tenant = arg('tenant') ?? 'demo';
  const ruleId = arg('rule');
  if (!TENANT_ID.test(tenant) || !ruleId || !RULE_ID.test(ruleId)) throw new Error('usage: pnpm rescan -- --tenant <tenant> --rule <rule_id>');
  const pc = loadPlatformConfig();
  const cfg = loadAgentConfig();
  const logger = createLogger({ service: 'rescan', projectId: pc.projectId });
  const platform = createPlatform(pc, logger);
  const offline = new OfflineLlm();
  const rules = createRuleService({
    state: platform.state,
    warehouse: platform.warehouse,
    reader: platform.reader,
    blob: platform.blob,
    publisher: platform.publisher,
    signalsTopic: pc.topics.signals,
    // A re-scan never calls a model; the stand-in only satisfies the type.
    models: { bulk: offline, reasoning: offline, offline: true },
    logger,
    tenants: [tenant],
    dryRun: { sessions: cfg.RULE_DRY_RUN_SESSIONS, days: cfg.RULE_DRY_RUN_DAYS },
    rescan: { sessions: cfg.RESCAN_MAX_SESSIONS, days: cfg.RESCAN_WINDOW_DAYS, concurrency: cfg.RESCAN_CONCURRENCY },
    revenue: { abandonAfterIdleMs: cfg.ABANDON_AFTER_IDLE_MS, minBaselineSessions: cfg.BASELINE_MIN_SESSIONS, minAffectedDecided: cfg.RAR_MIN_AFFECTED },
  });
  await rules.rescan(tenant, ruleId);
  await rules.idle();
  const status = (await platform.state.getRule(tenant, ruleId))?.rescan;
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  await platform.close();
  await flushLogs();
  process.exit(status?.status === 'done' ? 0 : 1);
}

main().catch(async (err: unknown) => {
  process.stderr.write(`rescan failed: ${err instanceof Error ? err.message : String(err)}\n`);
  await flushLogs();
  process.exit(1);
});
