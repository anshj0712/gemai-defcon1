import type { Logger } from '@cp/logger';
import type { StateStore } from '@cp/platform';
import { RecordedProbeSpecSchema, type RecordedProbeSpec } from '@cp/schema';

export interface ProbeSourceDeps {
  state: Pick<StateStore, 'listProbes'>;
  /** How long a tenant's probe list is reused before the state store is read again. */
  ttlMs: number;
  logger: Logger;
  now?: () => number;
}

/**
 * A tenant's active recorded probes (selectors read from the recorded page), cached per tenant for `ttlMs`
 * like the rules, so a probe approved on the dashboard is read from live traffic within that time. When the
 * store cannot be read, the last good list (or none) is used rather than failing the chunk.
 */
export function createProbeSource(deps: ProbeSourceDeps): (tenantId: string) => Promise<RecordedProbeSpec[]> {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { probes: RecordedProbeSpec[]; at: number }>();
  const inflight = new Map<string, Promise<RecordedProbeSpec[]>>();

  async function load(tenantId: string): Promise<RecordedProbeSpec[]> {
    try {
      const probes: RecordedProbeSpec[] = [];
      for (const doc of await deps.state.listProbes(tenantId)) {
        if (doc.status !== 'active') continue;
        const parsed = RecordedProbeSpecSchema.safeParse(doc.spec);
        if (parsed.success) probes.push(parsed.data);
        else deps.logger.warn({ tenant_id: tenantId, probe: doc.name }, 'recorded probe failed validation; skipped');
      }
      cache.set(tenantId, { probes, at: now() });
      return probes;
    } catch (err) {
      deps.logger.warn({ err, tenant_id: tenantId }, 'could not read recorded probes; using the last known set');
      return cache.get(tenantId)?.probes ?? [];
    }
  }

  return (tenantId) => {
    const hit = cache.get(tenantId);
    if (hit && now() - hit.at < deps.ttlMs) return Promise.resolve(hit.probes);
    let pending = inflight.get(tenantId);
    if (!pending) {
      pending = load(tenantId).finally(() => inflight.delete(tenantId));
      inflight.set(tenantId, pending);
    }
    return pending;
  };
}
