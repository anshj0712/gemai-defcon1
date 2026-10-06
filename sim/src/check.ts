import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arg, requireServices, say, URLS } from './browser.js';
import { evaluate, pct, type ClusterLike, type GroundTruth } from './truth.js';

/**
 * `pnpm sim:check`: the Phase 2 exit test. Reads the last `pnpm sim` ground truth, waits for the
 * pipeline to go quiet, then checks that each injected bug collapsed into exactly one issue, that no
 * clean session landed in any issue, and that recall meets the bar. Writes sim/out/check-report.json.
 * All sessions and numbers are synthetic.
 *
 *   pnpm sim:check [-- --min-recall 0.9] [--settle 8] [--out <dir>]
 */

const outDir = resolve(arg('out') ?? join('sim', 'out'));
const minRecall = Number(arg('min-recall') ?? 0.9);
/** Seconds with no new signals before scoring. */
const settleS = Number(arg('settle') ?? 8);

interface Summary {
  cluster_id: string;
  signal_count: number;
  last_seen: number;
}

const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${URLS.api}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
};

/** Poll until the total signal count stops changing for `settleS` seconds (or 3 minutes pass). */
async function waitForQuiet(): Promise<Summary[]> {
  const deadline = Date.now() + 180_000;
  let last = -1;
  let stableSince = Date.now();
  for (;;) {
    const { clusters } = await get<{ clusters: Summary[] }>('/v1/clusters?limit=200');
    const total = clusters.reduce((n, c) => n + c.signal_count, 0);
    if (total !== last) {
      last = total;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= settleS * 1000) return clusters;
    if (Date.now() > deadline) {
      say('  pipeline still busy after 3 minutes; scoring what has landed');
      return clusters;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main(): Promise<void> {
  const file = join(outDir, 'ground-truth.json');
  let truth: GroundTruth;
  try {
    truth = JSON.parse(readFileSync(file, 'utf8')) as GroundTruth;
  } catch {
    throw new Error(`no ground truth at ${file}. Run the simulator first: pnpm sim -- --sessions 100`);
  }
  await requireServices(['api']);
  say(`sim:check: ${truth.sessions.length} synthetic sessions (seed ${truth.seed}), waiting for the pipeline to go quiet…`);
  const summaries = await waitForQuiet();
  const clusters = await Promise.all(summaries.map(async (s) => (await get<{ cluster: ClusterLike }>(`/v1/clusters/${s.cluster_id}?sessions=5000`)).cluster));
  const report = evaluate(truth, clusters, minRecall);

  say('');
  say('  bug             sessions  issues  recall   precision  issue');
  for (const b of report.bugs) {
    say(`  ${b.bug.padEnd(15)} ${String(b.affected).padStart(8)}  ${String(b.clusters).padStart(6)}  ${pct(b.recall).padStart(6)}  ${pct(b.precision).padStart(9)}   ${b.title ?? '-'}`);
  }
  say(`  clean sessions in an issue: ${report.clean_in_clusters.length}`);
  say(`  unexpected issues: ${report.unexpected_clusters.length}${report.unexpected_clusters.map((u) => `\n    - ${u.title} (${u.sessions} sessions)`).join('')}`);
  if (report.failed_sessions) say(`  left out of scoring (browser run failed): ${report.failed_sessions}`);
  say('');
  say('  abandonment (synthetic, sessions with a bag):');
  for (const a of report.abandonment) say(`    ${a.group.padEnd(15)} ${String(a.abandoned).padStart(4)} / ${String(a.with_cart).padEnd(4)} ${pct(a.rate)}`);

  const reportFile = join(outDir, 'check-report.json');
  writeFileSync(reportFile, `${JSON.stringify({ ...report, seed: truth.seed, checked_at: Date.now(), min_recall: minRecall }, null, 2)}\n`);
  say('');
  say(`report: ${reportFile}`);
  if (!report.pass) {
    for (const f of report.failures) say(`  FAIL  ${f}`);
    say('FAIL: exit test not met (synthetic data)');
    process.exit(1);
  }
  say('PASS: each injected bug is one issue and no clean session is in any issue (synthetic data)');
}

main().catch((err: unknown) => {
  say(`sim:check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
