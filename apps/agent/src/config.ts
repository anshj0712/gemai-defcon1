import { z } from 'zod';
import { boolEnv, jsonEnv, parseEnv } from '@cp/platform';
import { PriorityRuleSchema, TENANT_ID } from '@cp/schema';

/** Agent service settings. Every one is documented in .env.example; model ids are never hard-coded in code paths. */
const AgentEnv = z.object({
  AGENT_PORT: z.coerce.number().int().min(1).default(8084),
  // Loopback for local runs; all interfaces on Cloud Run (K_SERVICE) or when HOST is set (containers).
  HOST: z.string().default(process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1'),
  /** auto: Gemini when GOOGLE_API_KEY is set, else the offline stand-in. vertex: Gemini on Vertex AI, with GOOGLE_API_KEY if it is a Vertex key (AQ...), else with ADC. */
  AGENT_LLM: z.enum(['auto', 'gemini', 'vertex', 'offline']).default('auto'),
  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_MODEL_BULK: z.string().default('gemini-3.5-flash-lite'),
  GEMINI_MODEL_REASONING: z.string().default('gemini-3.8-flash'),
  /** Comma-separated tenants the service scores. */
  AGENT_TENANTS: z
    .string()
    .default('demo')
    .transform((s) => s.split(',').map((t) => t.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(TENANT_ID)).min(1)),
  /** Run a pass this often (ms). 0 disables the timer; POST /run then triggers passes (Cloud Scheduler). */
  AGENT_POLL_MS: z.coerce.number().int().min(0).default(5000),
  /** Re-score an issue at most this often (ms); outcomes keep arriving, so scores move after the issue stops growing. */
  AGENT_RESCORE_MS: z.coerce.number().int().min(0).default(15_000),
  AGENT_MAX_PER_PASS: z.coerce.number().int().positive().default(5),
  AGENT_LOOKBACK_DAYS: z.coerce.number().positive().default(7),
  /** A cart without an order counts as abandoned after this much idle time (ms). Short for the demo; minutes to hours in production. */
  ABANDON_AFTER_IDLE_MS: z.coerce.number().int().positive().default(120_000),
  BASELINE_MIN_SESSIONS: z.coerce.number().int().min(1).default(20),
  RAR_MIN_AFFECTED: z.coerce.number().int().min(1).default(3),
  REGRESSION_WINDOW_HOURS: z.coerce.number().positive().default(24),
  /** Render a screenshot of the flagged moment for the visual check (needs a Chromium on the host). */
  VISUAL_CHECK: boolEnv.default(true),
  /** Browser for screenshots: an installed channel (chrome, msedge), a Chromium executable path, or "bundled" for Playwright's Chromium. */
  SCREENSHOT_BROWSER: z.string().default('chrome'),
  SCREENSHOT_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  MAX_REPLAY_CHUNKS: z.coerce.number().int().positive().default(1000),
  /** Optional JSON array replacing the built-in priority rule set. */
  PRIORITY_RULES: jsonEnv(PriorityRuleSchema.array().min(1)).optional(),
  /** Rule author dry run: the newest sessions it reads, and how far back. */
  RULE_DRY_RUN_SESSIONS: z.coerce.number().int().positive().default(1000),
  RULE_DRY_RUN_DAYS: z.coerce.number().positive().default(30),
  /** Retroactive re-scan after an approval: how far back, the most sessions one run reads, and sessions read in parallel. */
  RESCAN_WINDOW_DAYS: z.coerce.number().positive().default(30),
  RESCAN_MAX_SESSIONS: z.coerce.number().int().positive().default(5000),
  RESCAN_CONCURRENCY: z.coerce.number().int().positive().max(64).default(8),
  /** Agent-suggested rules: ask the rule suggester about recurring issues and draft its sentence (a person still approves). */
  RULE_SUGGEST: boolEnv.default(true),
  /** The trigger: at least this many affected sessions... */
  RULE_SUGGEST_MIN_SESSIONS: z.coerce.number().int().min(1).default(10),
  /** ...seen over at least this many days (0 for the demo, whose sessions span minutes; raise to 1 or more in production)... */
  RULE_SUGGEST_MIN_DAYS: z.coerce.number().min(0).default(0),
  /** ...with one symptom (detector) carrying at least this share of the issue's signals. */
  RULE_SUGGEST_MIN_DETECTOR_SHARE: z.coerce.number().min(0).max(1).default(0.5),
  /** Most of the issue's sessions read back from raw for the suggester's probe statistics. */
  RULE_SUGGEST_MAX_SESSIONS: z.coerce.number().int().min(1).default(25),
  /** The churn watcher: look at recent sessions for numbers that make shoppers leave, and draft a probe and rule (a person approves). */
  WATCH: boolEnv.default(true),
  /** How often it looks (ms); 0 disables the timer (POST /watch/run still works). */
  WATCH_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  WATCH_WINDOW_DAYS: z.coerce.number().positive().default(7),
  /** Newest sessions one pass reads (each read once from raw, then cached). */
  WATCH_MAX_SESSIONS: z.coerce.number().int().positive().default(1000),
  /** The bar a segment must clear: decided cart sessions in it, abandonment gap, and one-sided p-value. */
  WATCH_MIN_SEGMENT: z.coerce.number().int().min(2).default(6),
  WATCH_MIN_LIFT: z.coerce.number().min(0).max(1).default(0.3),
  WATCH_MAX_P: z.coerce.number().positive().max(1).default(0.01),
  /** Most hypotheses one pass hands to the churn analyst. */
  WATCH_MAX_CANDIDATES: z.coerce.number().int().min(1).default(3),
});

export type AgentConfig = z.infer<typeof AgentEnv>;

export const loadAgentConfig = (env: NodeJS.ProcessEnv = process.env): AgentConfig => parseEnv(AgentEnv, env);
