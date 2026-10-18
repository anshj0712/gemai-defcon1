import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '@cp/logger';
import { findRepoRoot, loadDotEnv } from '@cp/platform';
import { PROMPT_VERSION, RANKER, rankerInput, ROOT_CAUSE, rootCauseInput, TRIAGE, triageInput } from '../agents/prompts.js';
import { loadAgentConfig } from '../config.js';
import { citationErrors, validateRank, validateRootCause, validateTriage } from '../grounding.js';
import { convene } from '../jury.js';
import { createModels } from '../llm/models.js';
import { runStructured } from '../llm/run-agent.js';
import { DEFAULT_PRIORITY_RULES, parseRules } from '../scoring/index.js';
import { scoreJury, scoreRanker, scoreRootCause, scoreTriage, summarize, type CaseResult, type CheckResult, type EvalReport, type GoldenCase } from './score.js';

/**
 * `pnpm eval:agents`: the agents' regression eval. It asks the real model again about each golden case (a saved
 * evidence pack from a planted bug), scores the answers (score.ts) and writes `.data/eval-agents.json`. Run it before
 * changing a prompt or a model id; it calls Gemini, so it is not part of `pnpm test`.
 *
 *   pnpm eval:agents [-- --min 0.85] [--only dead_button] [--jury] [--concurrency 3]
 *
 * With no key it runs the offline stand-in, which proves the plumbing but says nothing about Gemini.
 */

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const val = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const say = (s: string) => process.stdout.write(`${s}\n`);

export function loadCases(dir: string, only?: string): GoldenCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as GoldenCase)
    .filter((c) => !only || c.bug === only || c.id === only)
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function main(): Promise<void> {
  const root = findRepoRoot();
  loadDotEnv(root);
  const cfg = loadAgentConfig();
  const models = createModels({ backend: cfg.AGENT_LLM, apiKey: cfg.GOOGLE_API_KEY, bulkModel: cfg.GEMINI_MODEL_BULK, reasoningModel: cfg.GEMINI_MODEL_REASONING, project: undefined, location: 'global' });
  const rules = parseRules(cfg.PRIORITY_RULES ?? DEFAULT_PRIORITY_RULES);
  const threshold = Number(val('min') ?? 0.85);
  const withJury = flag('jury');
  const cases = loadCases(join(root, 'apps', 'agent', 'eval', 'golden'), val('only'));
  if (cases.length === 0) throw new Error('no golden cases in apps/agent/eval/golden. Capture some: pnpm eval:capture -- --api <dashboard url>');
  const logger = createLogger({ service: 'eval', format: 'json', level: 'silent', toCloud: false });
  say(`eval:agents: ${cases.length} golden cases, prompts ${PROMPT_VERSION}, models ${models.offline ? 'offline stand-in' : `${models.bulk.model} + ${models.reasoning.model}`}${withJury ? ', with the jury' : ''}`);
  if (models.offline) say('  (offline stand-in: this checks the plumbing, not Gemini. Set GOOGLE_API_KEY and AGENT_LLM=vertex for the real eval.)');

  const results: CaseResult[] = [];
  const queue = [...cases];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const started = Date.now();
      const ids = new Set(c.evidence.map((e) => e.id));
      const t = await runStructured(TRIAGE, models.bulk, triageInput(c.evidence), (o) => validateTriage(o, ids), {});
      const rc = await runStructured(ROOT_CAUSE, models.reasoning, rootCauseInput(c.evidence, t.output, null), (o) => validateRootCause(o, ids, null), {});
      const rk = await runStructured(RANKER, models.bulk, rankerInput(c.evidence, { base_tier: c.base_tier, base_rule_ids: c.base_rule_ids, revenue: c.revenue, triage: t.output }, rules), (o) => validateRank(o, ids, rules), {});
      const checks: CheckResult[] = [...scoreTriage(c, t.output), ...scoreRootCause(c, rc.output), ...scoreRanker(rk.output)];
      let jurors: CaseResult['jurors'];
      let calls = 3;
      if (withJury && t.output) {
        const verdict = await convene(
          { models, params: { size: cfg.JURY_SIZE, threshold: cfg.JURY_THRESHOLD }, logger },
          {
            report: { title: t.output.title, tier: c.base_tier, affected_sessions: c.affected_sessions, revenue: { status: c.revenue.status, revenue_at_risk_minor: c.revenue.revenue_at_risk_minor, currency: c.revenue.currency, note: c.revenue.note }, triage: t.output, root_cause: rc.output, ranker: rk.output },
            evidence: c.evidence,
            checks: { agents_ok: Boolean(t.output && rc.output && rk.output), visual_ok: true },
            key: 'eval',
          },
        );
        checks.push(...scoreJury(verdict.outcome, verdict.mean_score));
        jurors = verdict.jurors.flatMap((j) => (j.score === null ? [] : [{ role: j.role, score: j.score }]));
        calls += verdict.jurors_asked + 1;
      }
      const result: CaseResult = { id: c.id, bug: c.bug, checks, pass: checks.every((k) => k.pass), ms: Date.now() - started, calls, ...(jurors ? { jurors } : {}), title: t.output?.title ?? null };
      results.push(result);
      say(`  ${result.pass ? 'PASS' : 'FAIL'}  ${c.bug.padEnd(15)} ${(result.ms / 1000).toFixed(1).padStart(5)} s  ${result.title ?? '(no valid triage)'}`);
      for (const k of checks.filter((x) => !x.pass)) say(`          - ${k.name}: ${k.detail}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(val('concurrency') ?? 3)) }, worker));
  results.sort((a, b) => a.id.localeCompare(b.id));

  const report: EvalReport = summarize(results, { at: Date.now(), offline: models.offline, models: { bulk: models.bulk.model, reasoning: models.reasoning.model }, prompt_version: PROMPT_VERSION, threshold });
  mkdirSync(join(root, '.data'), { recursive: true });
  writeFileSync(join(root, '.data', 'eval-agents.json'), `${JSON.stringify(report, null, 2)}\n`);
  say('');
  say('  check                 passed');
  for (const [name, e] of Object.entries(report.checks)) say(`  ${name.padEnd(21)} ${e.passed}/${e.total}`);
  say(`  cases passed          ${results.filter((r) => r.pass).length}/${results.length} (${Math.round(report.pass_rate * 100)}%), bar ${Math.round(threshold * 100)}%, mean ${(report.mean_ms / 1000).toFixed(1)} s per case`);
  say(report.pass ? 'PASS: the agents meet the bar on the golden cases' : 'FAIL: below the bar. Do not ship this prompt or model change.');
  process.exit(report.pass ? 0 : 1);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('eval/run.ts')) {
  main().catch((err: unknown) => {
    say(`eval:agents failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
