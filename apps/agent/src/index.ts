import { createLogger, flushLogs, logsExplorerUrl, resolveLogFormat, serviceLogFilter } from '@cp/logger';
import { createPlatform, loadDotEnv, loadPlatformConfig, loadReplay } from '@cp/platform';
import type { RuleAuthorMeta } from '@cp/schema';
import { loadAgentConfig } from './config.js';
import { createModels } from './llm/models.js';
import { DEFAULT_PRIORITY_RULES, parseRules, ruleSetVersion } from './scoring/index.js';
import { createRuleService } from './rules/service.js';
import { createFindingActions } from './finding-actions.js';
import { buildAgentServer } from './server.js';
import { createAgentService, recordRules } from './service.js';
import { DEFAULT_WATCH_PARAMS } from './watch/contrast.js';
import { createChurnWatcher } from './watch/watcher.js';
import { PlaywrightScreenshotter } from './visual/screenshot.js';

async function main(): Promise<void> {
  loadDotEnv();
  const pc = loadPlatformConfig();
  const cfg = loadAgentConfig();
  const logger = createLogger({ service: 'agent', projectId: pc.projectId });
  const platform = createPlatform(pc, logger);
  const models = createModels({
    backend: cfg.AGENT_LLM,
    apiKey: cfg.GOOGLE_API_KEY,
    bulkModel: cfg.GEMINI_MODEL_BULK,
    reasoningModel: cfg.GEMINI_MODEL_REASONING,
    project: pc.projectId,
    location: pc.region,
  });
  const rules = parseRules(cfg.PRIORITY_RULES ?? DEFAULT_PRIORITY_RULES);
  const screenshotter = cfg.VISUAL_CHECK ? new PlaywrightScreenshotter({ channel: cfg.SCREENSHOT_BROWSER === 'bundled' ? undefined : cfg.SCREENSHOT_BROWSER, timeoutMs: cfg.SCREENSHOT_TIMEOUT_MS }) : null;
  const lookbackMs = cfg.AGENT_LOOKBACK_DAYS * 86_400_000;
  const revenue = { abandonAfterIdleMs: cfg.ABANDON_AFTER_IDLE_MS, minBaselineSessions: cfg.BASELINE_MIN_SESSIONS, minAffectedDecided: cfg.RAR_MIN_AFFECTED };

  // Tenant rules (Phase 4): plain-English rule author, dry run, approval, and retroactive re-scan. Created
  // first: the agent pipeline hands rule suggestions to it as agent-originated drafts.
  const ruleService = createRuleService({
    state: platform.state,
    warehouse: platform.warehouse,
    reader: platform.reader,
    blob: platform.blob,
    publisher: platform.publisher,
    signalsTopic: pc.topics.signals,
    models,
    logger,
    tenants: cfg.AGENT_TENANTS,
    dryRun: { sessions: cfg.RULE_DRY_RUN_SESSIONS, days: cfg.RULE_DRY_RUN_DAYS },
    rescan: { sessions: cfg.RESCAN_MAX_SESSIONS, days: cfg.RESCAN_WINDOW_DAYS, concurrency: cfg.RESCAN_CONCURRENCY },
    revenue,
    // Shoppers the churn watcher suspects stay out of revenue baselines (set once the watcher exists, below).
    suspected: (tenant) => watcher?.suspected(tenant) ?? new Set<string>(),
  });

  const service = createAgentService({
    state: platform.state,
    warehouse: platform.warehouse,
    reader: platform.reader,
    blob: platform.blob,
    models,
    rules,
    screenshotter,
    logger,
    tenants: cfg.AGENT_TENANTS,
    rescoreMs: cfg.AGENT_RESCORE_MS,
    maxPerPass: cfg.AGENT_MAX_PER_PASS,
    lookbackMs,
    regressionWindowMs: cfg.REGRESSION_WINDOW_HOURS * 3_600_000,
    revenue,
    suspected: (tenant) => watcher?.suspected(tenant) ?? new Set<string>(),
    ...(cfg.JURY ? { jury: { size: cfg.JURY_SIZE, threshold: cfg.JURY_THRESHOLD } } : {}),
    loadReplay: (tenant, session) => loadReplay(platform, tenant, session, { sinceMs: Date.now() - lookbackMs, maxChunks: cfg.MAX_REPLAY_CHUNKS }),
    // Agent-suggested rules (ARCHITECTURE.md section 6): same rule service, origin agent, a person approves.
    ...(cfg.RULE_SUGGEST
      ? {
          ruleSuggest: {
            params: {
              enabled: true,
              minSessions: cfg.RULE_SUGGEST_MIN_SESSIONS,
              minDays: cfg.RULE_SUGGEST_MIN_DAYS,
              minDetectorShare: cfg.RULE_SUGGEST_MIN_DETECTOR_SHARE,
              maxSessions: cfg.RULE_SUGGEST_MAX_SESSIONS,
            },
            activeRules: (tenant: string) => ruleService.activeRules(tenant),
            probeStats: (tenant: string, sessionIds: string[]) => ruleService.probeStats(tenant, sessionIds),
            draft: (tenant: string, sentence: string, meta: { cluster_id: string; suggester: RuleAuthorMeta }) => ruleService.draft(tenant, sentence, { origin: 'agent', ...meta }),
          },
        }
      : {}),
  });

  // The churn watcher: numbers that make shoppers leave, proposed as a probe and rule a person approves.
  const watcher = cfg.WATCH
    ? createChurnWatcher({
        state: platform.state,
        reader: platform.reader,
        blob: platform.blob,
        models,
        logger,
        tenants: cfg.AGENT_TENANTS,
        rules: ruleService,
        params: { ...DEFAULT_WATCH_PARAMS, minSegment: cfg.WATCH_MIN_SEGMENT, minLift: cfg.WATCH_MIN_LIFT, maxP: cfg.WATCH_MAX_P, maxCandidates: cfg.WATCH_MAX_CANDIDATES },
        windowDays: cfg.WATCH_WINDOW_DAYS,
        maxSessions: cfg.WATCH_MAX_SESSIONS,
        concurrency: cfg.RESCAN_CONCURRENCY,
        revenue,
      })
    : null;

  await recordRules(platform.warehouse, cfg.AGENT_TENANTS, rules, Date.now());

  const interrupted = await ruleService.markInterrupted();
  if (interrupted) logger.warn({ rescans: interrupted }, 're-scans left running by a previous process were marked interrupted; re-run them from the Rules page');

  const info = {
    llm: models.offline ? 'offline stand-in (no GOOGLE_API_KEY)' : `${models.bulk.model} + ${models.reasoning.model}`,
    rule_set: ruleSetVersion(rules),
    visual_check: cfg.VISUAL_CHECK,
    rule_suggest: cfg.RULE_SUGGEST,
    churn_watch: cfg.WATCH ? cfg.WATCH_INTERVAL_MS : false,
  };
  const app = buildAgentServer({ logger, runPass: () => service.runPass(), info, projectId: pc.projectId, rules: ruleService, findings: createFindingActions(platform.state), ...(watcher ? { watcher } : {}) });
  await app.listen({ port: cfg.AGENT_PORT, host: cfg.HOST });
  logger.info({ mode: pc.mode, port: cfg.AGENT_PORT, tenants: cfg.AGENT_TENANTS, poll_ms: cfg.AGENT_POLL_MS, ...info }, 'agent ready');
  if (models.offline) logger.warn('no GOOGLE_API_KEY: agents use the offline stand-in (templated text, no visual check). Set GOOGLE_API_KEY for Gemini.');
  if (pc.projectId && (resolveLogFormat() === 'gcp' || process.env.LOG_TO_CLOUD === 'true')) {
    logger.info({ url: logsExplorerUrl(pc.projectId, serviceLogFilter(pc.projectId, { service: 'agent' })) }, 'logs in Cloud Logging');
  }

  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    try {
      await service.runPass();
    } catch (err) {
      logger.error({ err }, 'agent pass failed');
    } finally {
      if (timer !== null || cfg.AGENT_POLL_MS > 0) timer = setTimeout(() => void tick(), cfg.AGENT_POLL_MS);
    }
  };
  if (cfg.AGENT_POLL_MS > 0) timer = setTimeout(() => void tick(), 1000);

  let watchTimer: NodeJS.Timeout | null = null;
  const watchTick = async () => {
    try {
      await watcher?.runAll();
    } catch (err) {
      logger.error({ err }, 'churn watch pass failed');
    } finally {
      if (watchTimer !== null) watchTimer = setTimeout(() => void watchTick(), cfg.WATCH_INTERVAL_MS);
    }
  };
  if (watcher && cfg.WATCH_INTERVAL_MS > 0) watchTimer = setTimeout(() => void watchTick(), Math.min(cfg.WATCH_INTERVAL_MS, 15_000));

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    if (timer) clearTimeout(timer);
    timer = null;
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = null;
    await app.close();
    await screenshotter?.close();
    await platform.close();
    await flushLogs();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (err: unknown) => {
  process.stderr.write(`agent failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  await flushLogs();
  process.exit(1);
});
