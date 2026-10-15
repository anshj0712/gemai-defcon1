import { z } from 'zod';
import type { ParamOverrides } from '@cp/detectors';
import { boolEnv, DEFAULT_PROCESSOR_PORT, jsonEnv, loadPlatformConfig, parseEnv, type PlatformConfig } from '@cp/platform';
import { InvariantRuleSchema, type InvariantRule } from '@cp/schema';

const ProcessorEnv = z.object({
  PORT: z.coerce.number().int().min(1).default(DEFAULT_PROCESSOR_PORT),
  // Loopback for local runs; all interfaces on Cloud Run (K_SERVICE) or when HOST is set (containers).
  HOST: z.string().default(process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1'),
  /** Pull from the subscription instead of waiting for push (local runs against real GCP). */
  PROCESSOR_PULL: boolEnv.default(false),
  /** {"<tenant>": {"dead_click": {"windowMs": 1000}}} */
  DETECTOR_PARAMS: jsonEnv(z.record(z.string(), z.record(z.string(), z.record(z.string(), z.union([z.number(), z.string()]))))).optional(),
  /** How much normalized history the session tail keeps. Must cover every detector's window. */
  TAIL_LOOKBACK_MS: z.coerce.number().int().positive().default(10_000),
  TAIL_MAX_EVENTS: z.coerce.number().int().positive().default(2_000),
  TAIL_TTL_HOURS: z.coerce.number().positive().default(24),
  TAIL_CACHE_TTL_MS: z.coerce.number().int().positive().default(600_000),
  TAIL_CACHE_MAX: z.coerce.number().int().positive().default(5_000),
  PROCESSED_MARKER_TTL_DAYS: z.coerce.number().positive().default(7),
  /** Redeliveries to wait for a missing earlier chunk before processing out of order. */
  GAP_WAIT_ATTEMPTS: z.coerce.number().int().min(1).default(4),
  /** {"<tenant>": [rule, ...]}: replaces the built-in invariant rules for that tenant. */
  INVARIANT_RULES: jsonEnv(z.record(z.string(), z.array(InvariantRuleSchema))).optional(),
  /** How long approved tenant rules are cached before the state store is read again (an approval goes live within this). */
  RULES_CACHE_TTL_MS: z.coerce.number().int().min(0).default(15_000),
});

export interface ProcessorConfig {
  platform: PlatformConfig;
  port: number;
  host: string;
  pull: boolean;
  overrides: Record<string, ParamOverrides>;
  rules: Record<string, InvariantRule[]>;
  rulesCacheTtlMs: number;
  tailLookbackMs: number;
  tailMaxEvents: number;
  tailTtlMs: number;
  tailCacheTtlMs: number;
  tailCacheMax: number;
  markerTtlMs: number;
  gapWaitAttempts: number;
}

export function loadProcessorConfig(env: NodeJS.ProcessEnv = process.env): ProcessorConfig {
  const platform = loadPlatformConfig(env);
  const e = parseEnv(ProcessorEnv, env);
  return {
    platform,
    port: e.PORT,
    host: e.HOST,
    pull: e.PROCESSOR_PULL,
    overrides: e.DETECTOR_PARAMS ?? {},
    rules: e.INVARIANT_RULES ?? {},
    rulesCacheTtlMs: e.RULES_CACHE_TTL_MS,
    tailLookbackMs: e.TAIL_LOOKBACK_MS,
    tailMaxEvents: e.TAIL_MAX_EVENTS,
    tailTtlMs: e.TAIL_TTL_HOURS * 3_600_000,
    tailCacheTtlMs: e.TAIL_CACHE_TTL_MS,
    tailCacheMax: e.TAIL_CACHE_MAX,
    markerTtlMs: e.PROCESSED_MARKER_TTL_DAYS * 86_400_000,
    gapWaitAttempts: e.GAP_WAIT_ATTEMPTS,
  };
}
