import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import { traceBindings, type Logger } from '@cp/logger';
import { PROBE_NAME, RecordedProbeSpecSchema, RULE_ID, TENANT_ID } from '@cp/schema';
import { probeSpecProblem, RuleError, SENTENCE_LIMITS, type RuleService } from './rules/service.js';
import type { PassResult } from './service.js';

const DraftBody = z.object({ tenant: z.string().regex(TENANT_ID), sentence: z.string().min(1).max(SENTENCE_LIMITS.max * 2) });
const ApproveBody = z.object({ tenant: z.string().regex(TENANT_ID), version: z.int().min(1), approved_by: z.string().min(1).max(120).default('merchant') });
const TenantBody = z.object({ tenant: z.string().regex(TENANT_ID) });
const RuleParams = z.object({ id: z.string().regex(RULE_ID) });
const TenantQuery = z.object({ tenant: z.string().regex(TENANT_ID) });
const ProbeBody = z.object({ tenant: z.string().regex(TENANT_ID), spec: z.unknown(), by: z.string().min(1).max(120).default('merchant') });
const ProbeParams = z.object({ name: z.string().regex(PROBE_NAME) });
const ByBody = z.object({ tenant: z.string().regex(TENANT_ID), by: z.string().min(1).max(120).default('merchant') });

/**
 * HTTP surface of the agent service: health, POST /run to trigger a pass now (the local timer, or
 * Cloud Scheduler with an OIDC token when deployed, since the service is private), and the rule
 * actions the API forwards (draft with Gemini, approve and re-scan, reject, re-scan again).
 */
export function buildAgentServer(deps: {
  logger: Logger;
  runPass: () => Promise<PassResult[]>;
  info: Record<string, unknown>;
  projectId?: string | undefined;
  rules?: RuleService;
}): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    childLoggerFactory: (logger, bindings, opts, rawReq) => logger.child({ ...bindings, ...traceBindings(rawReq.headers, deps.projectId) }, opts),
  });
  app.get('/healthz', async () => ({ ok: true, service: 'agent', ...deps.info }));
  app.post('/run', async () => ({ results: await deps.runPass() }));

  const rules = deps.rules;
  if (rules) {
    const fail = (reply: FastifyReply, err: unknown) => {
      if (err instanceof RuleError) return reply.code(err.status).send({ error: err.code, message: err.message, author: err.author });
      throw err;
    };
    app.post('/rules/draft', async (req, reply) => {
      const body = DraftBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      try {
        return { rule: await rules.draft(body.data.tenant, body.data.sentence) };
      } catch (err) {
        return fail(reply, err);
      }
    });
    app.post('/rules/:id/approve', async (req, reply) => {
      const p = RuleParams.safeParse(req.params);
      const body = ApproveBody.safeParse(req.body);
      if (!p.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
      try {
        return { rule: await rules.approve(body.data.tenant, p.data.id, body.data.version, body.data.approved_by) };
      } catch (err) {
        return fail(reply, err);
      }
    });
    app.post('/rules/:id/reject', async (req, reply) => {
      const p = RuleParams.safeParse(req.params);
      const body = TenantBody.safeParse(req.body);
      if (!p.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
      try {
        return { rule: await rules.reject(body.data.tenant, p.data.id) };
      } catch (err) {
        return fail(reply, err);
      }
    });
    app.post('/rules/:id/rescan', async (req, reply) => {
      const p = RuleParams.safeParse(req.params);
      const body = TenantBody.safeParse(req.body);
      if (!p.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
      try {
        return { rule: await rules.rescan(body.data.tenant, p.data.id) };
      } catch (err) {
        return fail(reply, err);
      }
    });

    // Probes: what recent sessions report (declared, request, recorded), and recorded probes a merchant adds.
    app.get('/probes', async (req, reply) => {
      const q = TenantQuery.safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: 'invalid_request' });
      try {
        return await rules.listProbes(q.data.tenant);
      } catch (err) {
        return fail(reply, err);
      }
    });
    const specOf = (body: z.infer<typeof ProbeBody>, reply: FastifyReply) => {
      const problem = probeSpecProblem(body.spec);
      if (problem) {
        void reply.code(400).send({ error: 'invalid_probe', message: problem });
        return null;
      }
      return RecordedProbeSpecSchema.parse(body.spec);
    };
    app.post('/probes/preview', async (req, reply) => {
      const body = ProbeBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const spec = specOf(body.data, reply);
      if (!spec) return reply;
      try {
        return { preview: await rules.previewProbe(body.data.tenant, spec) };
      } catch (err) {
        return fail(reply, err);
      }
    });
    app.post('/probes', async (req, reply) => {
      const body = ProbeBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const spec = specOf(body.data, reply);
      if (!spec) return reply;
      try {
        return { probe: await rules.addProbe(body.data.tenant, spec, body.data.by) };
      } catch (err) {
        return fail(reply, err);
      }
    });
    app.post('/probes/:name/disable', async (req, reply) => {
      const p = ProbeParams.safeParse(req.params);
      const body = ByBody.safeParse(req.body);
      if (!p.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
      try {
        return { probe: await rules.disableProbe(body.data.tenant, p.data.name, body.data.by) };
      } catch (err) {
        return fail(reply, err);
      }
    });
  }
  return app;
}
