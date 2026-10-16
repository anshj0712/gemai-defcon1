import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arg, launchBrowser, requireServices, say } from './browser.js';
import { runPlan } from './personas.js';
import { DEFAULT_CONFIG, makePlans, type SessionPlan } from './plan.js';
import type { GroundTruth, TruthSession } from './truth.js';

/**
 * `pnpm sim`: synthetic shoppers on the demo shop in a real browser, each with known ground truth.
 * The mix is 20% dead_button, 15% cart_total, 15% checkout_error, 10% qty_price, 10% ghost_line, and 30%
 * clean (half of the clean sessions carry a bug flag they never trigger). Affected shoppers abandon more often than the
 * baseline, by design. Writes sim/out/ground-truth.json; then `pnpm sim:check` scores the issues.
 * Needs `pnpm dev` running. Every session and number is synthetic.
 *
 *   pnpm sim [-- --sessions 300] [--seed 42] [--concurrency 6] [--headed] [--channel chrome|msedge] [--out <dir>]
 */

const sessions = Number(arg('sessions') ?? 100);
const seed = Number(arg('seed') ?? 42);
const concurrency = Math.max(1, Number(arg('concurrency') ?? 6));
const headed = process.argv.includes('--headed');
const channel = arg('channel') ?? process.env.E2E_CHANNEL ?? 'chrome';
const outDir = resolve(arg('out') ?? join('sim', 'out'));
const SESSION_TIMEOUT_MS = 120_000;

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > 5000) throw new Error('--sessions must be 1 to 5000');
  if (!Number.isInteger(seed)) throw new Error('--seed must be an integer');
  await requireServices(['collector', 'api', 'shop']);
  mkdirSync(outDir, { recursive: true });

  const plans = makePlans(sessions, seed);
  const counts = plans.reduce<Record<string, number>>((m, p) => ((m[p.bug ?? 'clean'] = (m[p.bug ?? 'clean'] ?? 0) + 1), m), {});
  say(`sim: ${sessions} synthetic sessions, seed ${seed}, ${concurrency} at a time`);
  say(`  mix: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  const browser = await launchBrowser(channel, headed);
  const results: TruthSession[] = new Array(plans.length);
  const startedAt = Date.now();
  let next = 0;
  let done = 0;

  const runOne = async (plan: SessionPlan): Promise<TruthSession> => {
    const started = Date.now();
    const base = { index: plan.index, persona: plan.persona, bug: plan.bug, flags: plan.flags, currency: 'INR' as const, sample_rate: 1 as const, started_at: started };
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    try {
      const out = await withTimeout(runPlan(page, plan), SESSION_TIMEOUT_MS, `session ${plan.index}`);
      await page.close({ runBeforeUnload: true });
      return { ...base, ...out, abandoned: out.has_cart && !out.order_placed, ended_at: Date.now() };
    } catch (err) {
      const session_id = await page.evaluate(() => (globalThis as { cp?: { sessionId: string | null } }).cp?.sessionId ?? null).catch(() => null);
      return { ...base, session_id, has_cart: false, cart_value_minor: null, order_placed: false, abandoned: false, ended_at: Date.now(), error: err instanceof Error ? err.message.split('\n')[0]! : String(err) };
    } finally {
      await context.close().catch(() => undefined);
    }
  };

  const worker = async () => {
    for (;;) {
      const plan = plans[next++];
      if (!plan) return;
      const t = await runOne(plan);
      results[plan.index] = t;
      done += 1;
      const label = t.error ? `ERROR ${t.error}` : t.order_placed ? 'ordered' : t.abandoned ? 'abandoned' : 'no bag';
      say(`  [${String(done).padStart(String(sessions).length)}/${sessions}] ${plan.persona.padEnd(15)} ${(plan.bug ?? 'clean').padEnd(14)} ${t.session_id ?? '-'}  ${((t.ended_at - t.started_at) / 1000).toFixed(1)} s  ${label}`);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, plans.length) }, worker));
  } finally {
    await browser.close();
  }

  const truth: GroundTruth = { v: 1, synthetic: true, tenant_id: 'demo', seed, started_at: startedAt, finished_at: Date.now(), config: DEFAULT_CONFIG, sessions: results };
  const file = join(outDir, 'ground-truth.json');
  writeFileSync(file, `${JSON.stringify(truth, null, 2)}\n`);
  const failed = results.filter((r) => r.error).length;
  say(`done in ${((Date.now() - startedAt) / 1000).toFixed(0)} s: ${results.length - failed} sessions recorded${failed ? `, ${failed} failed (left out of scoring)` : ''}`);
  say(`ground truth: ${file}`);
  say('next: pnpm sim:check   (scores the issues against the ground truth; synthetic data)');
}

main().catch((err: unknown) => {
  say(`sim failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
