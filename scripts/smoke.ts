import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { BigQuery } from '@google-cloud/bigquery';
import { LocalWarehouse, loadDotEnv, loadPlatformConfig } from '@cp/platform';
import { applyCouponScenario, toEnvelopes } from '@cp/testkit';

/**
 * `pnpm smoke`: the Phase 1 exit test, driven by a synthetic session instead of the browser SDK.
 * Sends one Apply Coupon session (answers 5 clicks, then goes dead) to the collector and waits
 * for the dead_click signal rows to land in the warehouse. All data is synthetic.
 *
 *   pnpm smoke [-- --collector http://localhost:8080] [--timeout 60]
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

loadDotEnv();
const platform = loadPlatformConfig();
const collector = (arg('collector') ?? process.env.COLLECTOR_URL ?? `http://localhost:${process.env.PORT ?? 8080}`).replace(/\/$/, '');
const timeoutMs = Number(arg('timeout') ?? 60) * 1000;
/** First configured site key and its tenant (the local demo key when SITE_KEYS is unset). */
const { siteKey, tenantId } = (() => {
  try {
    const [entry] = Object.entries(JSON.parse(process.env.SITE_KEYS ?? '{}') as Record<string, string | { tenant_id: string }>);
    if (entry) return { siteKey: entry[0], tenantId: typeof entry[1] === 'string' ? entry[1] : entry[1].tenant_id };
  } catch {
    // fall through to the local default
  }
  return { siteKey: 'pk_local_demo', tenantId: 'demo' };
})();

const say = (s: string) => process.stdout.write(`${s}\n`);

async function signalsFor(sessionId: string): Promise<Record<string, unknown>[]> {
  if (platform.mode === 'local') {
    return (await new LocalWarehouse(join(platform.localDataDir, 'bq')).rows('signals')).filter((r) => r.tenant_id === tenantId && r.session_id === sessionId);
  }
  const bq = new BigQuery({ projectId: platform.projectId!, location: platform.region });
  const [rows] = await bq.query({
    query: `SELECT detector, element_selector, fingerprint, event_time, ingest_time
            FROM \`${platform.projectId}.${platform.dataset}.signals\`
            WHERE tenant_id = @tenant AND session_id = @session
              AND event_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)`,
    params: { tenant: tenantId, session: sessionId },
    maximumBytesBilled: '100000000',
  });
  return rows as Record<string, unknown>[];
}

async function main(): Promise<void> {
  say(`smoke: synthetic session -> ${collector} (CP_MODE=${platform.mode})`);
  try {
    const health = await fetch(`${collector}/healthz`);
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    say(`collector is not reachable at ${collector} (${(err as Error).message}). Start the pipeline with: pnpm dev`);
    process.exit(1);
  }

  const sessionId = `s_smoke_${randomBytes(6).toString('hex')}`;
  const scenario = applyCouponScenario({ start: Date.now() - 12_000, clicks: 7, respondFirst: 5 });
  const envelopes = toEnvelopes(scenario.events, { sessionId, siteKey, batchMs: 3000, end: scenario.end, release: 'git:smoke' });
  const expected = scenario.deadClickIndexes.length;

  const started = Date.now();
  for (const env of envelopes) {
    const body = gzipSync(JSON.stringify({ ...env, client_sent_at: Date.now() }));
    const res = await fetch(`${collector}/v1/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body });
    if (res.status !== 202) {
      say(`batch ${env.seq} rejected: HTTP ${res.status} ${await res.text()}`);
      process.exit(1);
    }
  }
  say(`sent ${envelopes.length} batches for ${sessionId}; expecting ${expected} dead_click signals on button#apply-coupon`);

  let rows: Record<string, unknown>[] = [];
  while (Date.now() - started < timeoutMs) {
    rows = await signalsFor(sessionId);
    if (rows.length >= expected) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  for (const r of rows) say(`  signal ${r.detector} ${r.element_selector} fingerprint=${r.fingerprint}`);
  if (rows.length >= expected) {
    say(`PASS: ${rows.length} signal rows within ${elapsed}s (synthetic data)`);
  } else {
    say(`FAIL: ${rows.length}/${expected} signal rows after ${elapsed}s. Check the processor logs.`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  say(`smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
