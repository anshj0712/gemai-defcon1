import type { Logger } from '@cp/logger';
import type { StateStore } from '@cp/platform';
import type { SignalRow } from '@cp/schema';
import { applySignal, clusterKeyFor } from './cluster.js';

export type ClusterOutcome = 'created' | 'updated' | 'duplicate' | 'capped';

export interface ClustererDeps {
  state: StateStore;
  logger: Logger;
  /** New clusters past this count are refused for the tenant (cardinality guard). */
  maxClustersPerTenant: number;
  /** How long "this signal was applied" markers are kept (covers Pub/Sub redelivery). */
  markerTtlMs: number;
  now?: () => number;
}

/** How long a tenant's cluster count is trusted before it is re-read. */
const COUNT_TTL_MS = 30_000;

export function createClusterer(deps: ClustererDeps) {
  const now = deps.now ?? Date.now;
  const counts = new Map<string, { count: number; at: number }>();

  async function tenantCount(tenantId: string): Promise<number> {
    const cached = counts.get(tenantId);
    if (cached && now() - cached.at < COUNT_TTL_MS) return cached.count;
    const count = await deps.state.countClusters(tenantId);
    counts.set(tenantId, { count, at: now() });
    return count;
  }

  return {
    async apply(row: SignalRow): Promise<ClusterOutcome> {
      const key = clusterKeyFor(row);
      const count = await tenantCount(row.tenant_id);
      let created = false;
      let capped = false;
      const result = await deps.state.applyToCluster(
        row.tenant_id,
        key.cluster_id,
        row.signal_id,
        (current) => {
          if (!current && count >= deps.maxClustersPerTenant) {
            capped = true;
            return null;
          }
          created = !current;
          return applySignal(current, row, key, now());
        },
        deps.markerTtlMs,
      );
      const log = deps.logger.child({ tenant_id: row.tenant_id, cluster_id: key.cluster_id });
      if (capped) {
        log.warn({ max: deps.maxClustersPerTenant, detector: row.detector }, 'cluster cap reached for tenant; signal not clustered');
        return 'capped';
      }
      if (!result.applied) {
        log.debug({ signal_id: row.signal_id }, 'signal already clustered; acking redelivery');
        return 'duplicate';
      }
      if (created) {
        const c = counts.get(row.tenant_id);
        if (c) c.count += 1;
      }
      const c = result.cluster!;
      log.info(
        { title: c.title, detector: row.detector, signals: c.signal_count, sessions: c.session_count, symptoms: c.detectors },
        created ? 'issue opened' : 'issue updated',
      );
      return created ? 'created' : 'updated';
    },
  };
}
