import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StateStore, WarehouseReader } from '@cp/platform';
import { TENANT_ID, type FindingRow, type RuleDoc } from '@cp/schema';

/**
 * Time travel (ARCHITECTURE.md section 6): "On T, what did we think happened in [from, to), versus what
 * we know now about the same window." Both answers come from the bitemporal `findings` record (the
 * as-of query over findings_versions), not the hot copy. A finding in today's answer but not in T's
 * is found later: shoppers were already hurt, but the rules at T did not flag it.
 */

export interface HistoryFinding {
  finding_id: string;
  version: number | null;
  title: string;
  tier: string;
  score: number | null;
  status: string | null;
  revenue_at_risk_minor: number;
  currency: string;
  revenue_status: string | null;
  affected_sessions: number;
  kind: string | null;
  route: string | null;
  /** Valid time: when shoppers first hit it (as believed in this version). */
  valid_from: number;
  /** Transaction time: when this version was written, and when it was replaced. */
  recorded_from: number;
  recorded_to: number | null;
  found_later_sessions: number;
  model_version: string | null;
}

export interface HistoryMoment {
  at: number;
  kind: 'rule_approved' | 'rescan_done';
  rule_id: string;
  label: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);

export function historyView(r: FindingRow): HistoryFinding {
  const d = (r.details ?? {}) as Record<string, unknown>;
  const revenue = (d.revenue ?? {}) as Record<string, unknown>;
  const discovery = (d.discovery ?? {}) as Record<string, unknown>;
  return {
    finding_id: r.finding_id,
    version: typeof d.version === 'number' ? d.version : null,
    title: r.title ?? r.summary,
    tier: r.severity,
    score: r.score,
    status: r.status,
    revenue_at_risk_minor: r.revenue_at_risk_minor,
    currency: r.currency,
    revenue_status: str(revenue.status),
    affected_sessions: r.affected_sessions,
    kind: str(d.kind),
    route: str(d.route),
    valid_from: r.valid_from,
    recorded_from: r.recorded_from,
    recorded_to: r.recorded_to,
    found_later_sessions: typeof discovery.found_later_sessions === 'number' ? discovery.found_later_sessions : 0,
    model_version: r.model_version,
  };
}

/** Rule approvals and finished re-scans: the moments worth jumping to on the time slider. */
export function historyMoments(rules: readonly RuleDoc[]): HistoryMoment[] {
  const out: HistoryMoment[] = [];
  for (const r of rules) {
    for (const v of r.versions) out.push({ at: v.approved_at, kind: 'rule_approved', rule_id: r.rule_id, label: `Rule approved: ${r.title} (v${v.version})` });
    const s = r.rescan;
    if (s?.status === 'done' && s.finished_at !== null) {
      out.push({ at: s.finished_at, kind: 'rescan_done', rule_id: r.rule_id, label: `Re-scan done: ${s.sessions_hit} session${s.sessions_hit === 1 ? '' : 's'} hit by ${r.title}` });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const HistoryQuery = z.object({
  tenant: z.string().regex(TENANT_ID).optional(),
  as_of: z.coerce.number().int().positive().optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().positive().optional(),
});

/** Default valid-time window when none is given: the week before the as-of moment. */
const DEFAULT_WINDOW_MS = 7 * 86_400_000;

export function registerHistoryRoute(app: FastifyInstance, deps: { reader: WarehouseReader; state: StateStore; defaultTenant: string; lookbackMs: number; now: () => number }): void {
  app.get('/v1/history', async (req, reply) => {
    const q = HistoryQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_query' });
    const tenant = q.data.tenant ?? deps.defaultTenant;
    const now = deps.now();
    const asOf = Math.min(q.data.as_of ?? now, now);
    const to = q.data.to ?? asOf;
    const from = q.data.from ?? to - DEFAULT_WINDOW_MS;
    if (from >= to) return reply.code(400).send({ error: 'invalid_window' });
    const window = { tenantId: tenant, validFrom: from, validTo: to, sinceMs: from - deps.lookbackMs };
    const [thenRows, nowRows, rules] = await Promise.all([deps.reader.findingsAsOf({ ...window, asOf }), deps.reader.findingsAsOf({ ...window, asOf: now }), deps.state.listRules(tenant)]);
    const then = thenRows.map(historyView);
    const current = nowRows.map(historyView);
    const known = new Set(then.map((f) => f.finding_id));
    return reply.header('cache-control', 'no-store').send({
      tenant,
      as_of: asOf,
      checked_at: now,
      window: { from, to },
      then,
      current,
      found_later: current.filter((f) => !known.has(f.finding_id)).map((f) => f.finding_id),
      moments: historyMoments(rules),
      synthetic: true,
    });
  });
}
