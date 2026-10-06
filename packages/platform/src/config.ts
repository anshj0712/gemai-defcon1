import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Nearest directory at or above `start` holding pnpm-workspace.yaml; `start` itself if none. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/**
 * Loads the nearest `.env` at or above `start` (stopping at the repo root). Variables already set in
 * the environment win. Skipped on Cloud Run, where configuration comes from the deploy.
 */
export function loadDotEnv(start: string = process.cwd()): string | null {
  if (process.env.K_SERVICE) return null;
  const root = findRepoRoot(start);
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Treat `KEY=` in .env as unset. */
function withoutEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

/** Parse env vars with a zod schema, failing with one readable message that lists every problem. */
export function parseEnv<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv = process.env): z.infer<S> {
  const result = schema.safeParse(withoutEmpty(env));
  if (result.success) return result.data;
  const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`);
  throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}\nSee .env.example for every setting.`);
}

export const jsonEnv = <S extends z.ZodType>(schema: S) =>
  z.string().transform((raw, ctx) => {
    try {
      return schema.parse(JSON.parse(raw)) as z.infer<S>;
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: `must be JSON matching the expected shape (${(err as Error).message.split('\n')[0]})` });
      return z.NEVER;
    }
  });

export const boolEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const PlatformEnv = z
  .object({
    CP_MODE: z.enum(['local', 'gcp']).default('local'),
    GCP_PROJECT_ID: z.string().optional(),
    GCP_REGION: z.string().default('asia-south1'),
    RAW_BUCKET: z.string().optional(),
    BQ_DATASET: z.string().default('churn_preventer'),
    TOPIC_EVENTS_RAW: z.string().default('events.raw'),
    TOPIC_SIGNALS: z.string().default('signals'),
    SUB_EVENTS_RAW: z.string().default('events.raw.processor'),
    SUB_SIGNALS: z.string().default('signals.clusterer'),
    FIRESTORE_DATABASE: z.string().default('(default)'),
    LOCAL_DATA_DIR: z.string().default('.data'),
    LOCAL_PUSH_ENDPOINTS: jsonEnv(z.record(z.string(), z.url())).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.CP_MODE === 'gcp' && !e.GCP_PROJECT_ID) {
      ctx.addIssue({ code: 'custom', path: ['GCP_PROJECT_ID'], message: 'required when CP_MODE=gcp' });
    }
  });

export type Mode = 'local' | 'gcp';

export interface PlatformConfig {
  mode: Mode;
  projectId: string | undefined;
  region: string;
  rawBucket: string;
  dataset: string;
  topics: { eventsRaw: string; signals: string };
  subscriptions: { eventsRaw: string; signals: string };
  firestoreDatabase: string;
  /** Absolute path of the local-mode data directory. */
  localDataDir: string;
  /** local mode: topic -> URL that receives Pub/Sub-style push requests. */
  localPushEndpoints: Record<string, string>;
}

export const DEFAULT_PROCESSOR_PORT = 8081;
export const DEFAULT_CLUSTERER_PORT = 8083;

export function loadPlatformConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const e = parseEnv(PlatformEnv, env);
  const root = findRepoRoot();
  return {
    mode: e.CP_MODE,
    projectId: e.GCP_PROJECT_ID,
    region: e.GCP_REGION,
    rawBucket: e.RAW_BUCKET ?? (e.GCP_PROJECT_ID ? `${e.GCP_PROJECT_ID}-cp-raw` : 'cp-raw'),
    dataset: e.BQ_DATASET,
    topics: { eventsRaw: e.TOPIC_EVENTS_RAW, signals: e.TOPIC_SIGNALS },
    subscriptions: { eventsRaw: e.SUB_EVENTS_RAW, signals: e.SUB_SIGNALS },
    firestoreDatabase: e.FIRESTORE_DATABASE,
    localDataDir: isAbsolute(e.LOCAL_DATA_DIR) ? e.LOCAL_DATA_DIR : join(root, e.LOCAL_DATA_DIR),
    localPushEndpoints: e.LOCAL_PUSH_ENDPOINTS ?? {
      [e.TOPIC_EVENTS_RAW]: `http://localhost:${DEFAULT_PROCESSOR_PORT}/pubsub/push`,
      [e.TOPIC_SIGNALS]: `http://localhost:${DEFAULT_CLUSTERER_PORT}/pubsub/push`,
    },
  };
}
