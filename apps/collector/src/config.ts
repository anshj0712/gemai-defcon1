import { z } from 'zod';
import { jsonEnv, loadPlatformConfig, parseEnv, type PlatformConfig } from '@cp/platform';
import { TENANT_ID } from '@cp/schema';

const TenantId = z.string().regex(TENANT_ID, 'tenant ids are lowercase letters, digits, - and _');

/** SITE_KEYS: {"pk_live_abc": "tenant"} or {"pk_live_abc": {"tenant_id": "tenant", "origins": ["https://shop.example"]}} */
export const SiteKeysSchema = z.record(
  z.string().min(8),
  z.union([TenantId, z.object({ tenant_id: TenantId, origins: z.array(z.string()).optional() })]),
);

export interface SiteKey {
  tenantId: string;
  /** When set, requests carrying an Origin header must match one of these. */
  origins?: string[];
}

export type SiteKeyMap = ReadonlyMap<string, SiteKey>;

export function toSiteKeyMap(raw: z.infer<typeof SiteKeysSchema>): SiteKeyMap {
  return new Map(
    Object.entries(raw).map(([key, v]) => [key, typeof v === 'string' ? { tenantId: v } : { tenantId: v.tenant_id, ...(v.origins ? { origins: v.origins } : {}) }]),
  );
}

/** Used only in local mode when SITE_KEYS is not set. */
export const LOCAL_DEFAULT_SITE_KEYS = { pk_local_demo: 'demo' } as const;

const CollectorEnv = z.object({
  PORT: z.coerce.number().int().min(1).default(8080),
  // Loopback for local runs; all interfaces on Cloud Run (K_SERVICE) or when HOST is set (containers).
  HOST: z.string().default(process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1'),
  SITE_KEYS: jsonEnv(SiteKeysSchema).optional(),
  /** Largest request body accepted, compressed. */
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(1_000_000),
  /** Largest batch accepted after gunzip (zip-bomb guard). */
  MAX_DECOMPRESSED_BYTES: z.coerce.number().int().positive().default(10_000_000),
});

export interface CollectorConfig {
  platform: PlatformConfig;
  port: number;
  host: string;
  siteKeys: SiteKeyMap;
  usingDefaultSiteKeys: boolean;
  maxBodyBytes: number;
  maxDecompressedBytes: number;
}

export function loadCollectorConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  const platform = loadPlatformConfig(env);
  const e = parseEnv(CollectorEnv, env);
  if (!e.SITE_KEYS && platform.mode === 'gcp') {
    throw new Error('SITE_KEYS is required when CP_MODE=gcp (on Cloud Run it comes from the site-keys secret)');
  }
  return {
    platform,
    port: e.PORT,
    host: e.HOST,
    siteKeys: toSiteKeyMap(e.SITE_KEYS ?? LOCAL_DEFAULT_SITE_KEYS),
    usingDefaultSiteKeys: !e.SITE_KEYS,
    maxBodyBytes: e.MAX_BODY_BYTES,
    maxDecompressedBytes: e.MAX_DECOMPRESSED_BYTES,
  };
}
