import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { BUILTIN_RULES } from '@cp/detectors';
import type { StateStore } from '@cp/platform';
import { RULE_ID, ruleText, ruleVersionOf, TENANT_ID } from '@cp/schema';

/**
 * Tenant rules (Phase 4). Reads come from the rule hot docs in the state store. The three write
 * actions are forwarded to the agent service, the only writer of rule docs, which runs the rule
 * author (Gemini), the dry run, the approval record, and the re-scan.
 */

export interface RuleRouteDeps {
  state: StateStore;
  defaultTenant: string;
  /** Base URL of the agent service, for example http://127.0.0.1:8084. */
  agentUrl: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** On Cloud Run the agent is private: an ID token for its URL is fetched from the metadata server. */
  agentAuth?: 'none' | 'metadata';
}

export const DEFAULT_AGENT_URL = 'http://127.0.0.1:8084';

const TenantQuery = z.object({ tenant: z.string().regex(TENANT_ID).optional() });
const RuleParams = z.object({ id: z.string().regex(RULE_ID) });
const DraftBody = z.object({ sentence: z.string().min(1).max(1000) });
const ApproveBody = z.object({ version: z.int().min(1) });

/** How long a forwarded action may take: the rule author calls Gemini and dry-runs up to 1000 sessions. */
const AGENT_TIMEOUT_MS = 120_000;

async function metadataIdToken(fetchImpl: typeof fetch, audience: string): Promise<string> {
  const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`;
  const res = await fetchImpl(url, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`metadata server: HTTP ${res.status}`);
  return res.text();
}

export function registerRuleRoutes(app: FastifyInstance, deps: RuleRouteDeps): void {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const tenantOf = (q: unknown) => {
    const t = TenantQuery.safeParse(q);
    return t.success ? (t.data.tenant ?? deps.defaultTenant) : null;
  };

  async function forward(reply: FastifyReply, path: string, body: Record<string, unknown>) {
    const url = `${deps.agentUrl.replace(/\/$/, '')}${path}`;
    let res: Response;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (deps.agentAuth === 'metadata') headers.authorization = `Bearer ${await metadataIdToken(fetchImpl, deps.agentUrl)}`;
      res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) });
    } catch (err) {
      return reply.code(502).send({ error: 'agent_unavailable', message: `the agent service did not answer (${err instanceof Error ? err.message : String(err)}). Is it running? Try pnpm dev.` });
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return reply.code(502).send({ error: 'agent_bad_response', message: `the agent service answered HTTP ${res.status} without JSON` });
    }
    return reply.code(res.status).header('cache-control', 'no-store').send({ ...(json as object), synthetic: true });
  }

  app.get('/v1/rules', async (req, reply) => {
    const tenant = tenantOf(req.query);
    if (!tenant) return reply.code(400).send({ error: 'invalid_query' });
    const rules = await deps.state.listRules(tenant);
    const builtin = BUILTIN_RULES.map((r) => ({ rule_id: r.id, version: r.version, title: r.title, rule_version: ruleVersionOf(r), text: ruleText(r) }));
    return reply.header('cache-control', 'no-store').send({ tenant, rules, builtin, synthetic: true });
  });

  app.get('/v1/rules/:id', async (req, reply) => {
    const p = RuleParams.safeParse(req.params);
    const tenant = tenantOf(req.query);
    if (!p.success || !tenant) return reply.code(400).send({ error: 'invalid_request' });
    const rule = await deps.state.getRule(tenant, p.data.id);
    if (!rule) return reply.code(404).send({ error: 'rule_not_found' });
    return reply.header('cache-control', 'no-store').send({ rule, synthetic: true });
  });

  app.post('/v1/rules/draft', async (req, reply) => {
    const tenant = tenantOf(req.query);
    const body = DraftBody.safeParse(req.body);
    if (!tenant || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    return forward(reply, '/rules/draft', { tenant, sentence: body.data.sentence });
  });

  app.post('/v1/rules/:id/approve', async (req, reply) => {
    const p = RuleParams.safeParse(req.params);
    const tenant = tenantOf(req.query);
    const body = ApproveBody.safeParse(req.body);
    if (!p.success || !tenant || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    // No sign-in yet (the API is loopback-only until Phase 5), so the approver is recorded as the dashboard.
    return forward(reply, `/rules/${p.data.id}/approve`, { tenant, version: body.data.version, approved_by: 'dashboard' });
  });

  for (const action of ['reject', 'rescan'] as const) {
    app.post(`/v1/rules/:id/${action}`, async (req, reply) => {
      const p = RuleParams.safeParse(req.params);
      const tenant = tenantOf(req.query);
      if (!p.success || !tenant) return reply.code(400).send({ error: 'invalid_request' });
      return forward(reply, `/rules/${p.data.id}/${action}`, { tenant });
    });
  }
}
