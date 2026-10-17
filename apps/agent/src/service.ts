import type { Logger } from '@cp/logger';
import type { StateStore, Warehouse } from '@cp/platform';
import type { Cluster, Finding, PriorityRule } from '@cp/schema';
import { analyze, tenantContext, toFindingRow, type PipelineDeps } from './pipeline.js';

/**
 * The agent service loop. Each pass, per tenant: read the live issues, pick the ones due (new, or not
 * re-scored for `rescoreMs`), biggest first, and run the pipeline on at most `maxPerPass`. A changed
 * finding writes a new version row to BigQuery (append-only, never updated) and refreshes the
 * Firestore hot copy that the feed reads. Passes never overlap.
 */

export interface ServiceDeps extends PipelineDeps {
  state: StateStore;
  warehouse: Warehouse;
  tenants: readonly string[];
  rescoreMs: number;
  maxPerPass: number;
  /** Shoppers the churn watcher suspects (kept out of revenue baselines); none when the watcher is off. */
  suspected?: (tenant: string) => ReadonlySet<string>;
}

export interface PassResult {
  tenant: string;
  clusters: number;
  analyzed: number;
  versions: number;
  failed: number;
}

/** Due when there is no finding yet, or it was last scored `rescoreMs` ago (outcomes keep arriving). */
export function dueClusters(clusters: readonly Cluster[], findings: ReadonlyMap<string, Finding>, now: number, rescoreMs: number, max: number): Cluster[] {
  return clusters
    .filter((c) => {
      const f = findings.get(c.cluster_id);
      return !f || now - f.updated_at >= rescoreMs;
    })
    .sort((a, b) => {
      const fa = findings.has(a.cluster_id) ? 1 : 0;
      const fb = findings.has(b.cluster_id) ? 1 : 0;
      return fa - fb || b.session_count - a.session_count;
    })
    .slice(0, max);
}

/** Records the priority rule set in the `rules` table, once per tenant and rule version (idempotent insertIds). */
export async function recordRules(warehouse: Warehouse, tenants: readonly string[], rules: readonly PriorityRule[], now: number): Promise<void> {
  await warehouse.insert(
    'rules',
    tenants.flatMap((tenant) =>
      rules.map((r) => ({
        insertId: `${tenant}:priority:${r.id}@${r.version}`,
        row: { tenant_id: tenant, rule_id: r.id, version: r.version, kind: 'builtin' as const, definition: { type: 'priority', ...r }, created_by: 'agent-service', recorded_at: now },
      })),
    ),
  );
}

export function createAgentService(deps: ServiceDeps) {
  const now = deps.now ?? Date.now;
  let running: Promise<PassResult[]> | null = null;

  async function passTenant(tenant: string): Promise<PassResult> {
    const result: PassResult = { tenant, clusters: 0, analyzed: 0, versions: 0, failed: 0 };
    const clusters = await deps.state.listClusters(tenant, 500);
    result.clusters = clusters.length;
    if (clusters.length === 0) return result;
    const findings = new Map((await deps.state.listFindings(tenant, 1000)).map((f) => [f.finding_id, f]));
    const due = dueClusters(clusters, findings, now(), deps.rescoreMs, deps.maxPerPass);
    if (due.length === 0) return result;

    const outcomes = await deps.reader.sessionOutcomes(tenant, now() - deps.lookbackMs);
    const ctx = tenantContext(clusters, outcomes, deps.suspected?.(tenant));
    for (const cluster of due) {
      const log = deps.logger.child({ tenant_id: tenant, cluster_id: cluster.cluster_id });
      try {
        const previous = findings.get(cluster.cluster_id) ?? null;
        const finding = await analyze(deps, cluster, ctx, previous);
        result.analyzed += 1;
        if (!previous || previous.input_hash !== finding.input_hash) {
          await deps.warehouse.insert('findings', [{ insertId: `${tenant}:${finding.finding_id}:${finding.input_hash}`, row: toFindingRow(finding, finding.updated_at) }]);
          result.versions += 1;
          log.info(
            {
              version: finding.version,
              tier: finding.tier,
              score: finding.score,
              revenue_at_risk_minor: finding.revenue.revenue_at_risk_minor,
              revenue_status: finding.revenue.status,
              sessions: finding.affected_sessions,
              status: finding.status,
              model: finding.model_version,
            },
            previous ? 'finding updated (new version)' : 'finding opened',
          );
        }
        await deps.state.putFinding(finding);
      } catch (err) {
        result.failed += 1;
        log.error({ err }, 'finding pass failed for this issue; will retry next pass');
      }
    }
    return result;
  }

  return {
    /** One pass over every tenant. Concurrent callers share the pass in flight. */
    runPass(): Promise<PassResult[]> {
      running ??= (async () => {
        try {
          const results: PassResult[] = [];
          for (const t of deps.tenants) results.push(await passTenant(t));
          return results;
        } finally {
          running = null;
        }
      })();
      return running;
    },
  };
}
