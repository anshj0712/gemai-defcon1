import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arg, requireServices, say } from './browser.js';
import { get, waitForFindings, waitForQuiet } from './pipeline.js';
import { evaluate, evaluateFindings, pct, type ClusterLike, type GroundTruth } from './truth.js';

/**
 * `pnpm sim:check`: the Phase 2 and Phase 3 exit tests. Reads the last `pnpm sim` ground truth, waits
 * for the pipeline to go quiet, then checks that each injected bug collapsed into exactly one issue,
 * that no clean session landed in any issue, and that recall meets the bar (Phase 2); then that each
 * bug's issue has a finding with an agent summary, repro steps, and a working replay link (Phase 3).
 * Writes sim/out/check-report.json. All sessions and numbers are synthetic.
 *
 *   pnpm sim:check [-- --min-recall 0.9] [--settle 8] [--out <dir>]
 */

const outDir = resolve(arg('out') ?? join('sim', 'out'));
const minRecall = Number(arg('min-recall') ?? 0.9);
/** Seconds with no new signals before scoring. */
const settleS = Number(arg('settle') ?? 8);
/** Seconds to wait for the agent service to score every bug's issue. */
const findingsWaitS = Number(arg('findings-wait') ?? 60);

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
  const summaries = await waitForQuiet(settleS);
  const clusters = await Promise.all(summaries.map(async (s) => (await get<{ cluster: ClusterLike }>(`/v1/clusters/${s.cluster_id}?sessions=5000`)).cluster));
  const report = evaluate(truth, clusters, minRecall);

  say('');
  say('  bug             sessions  issues  recall   precision  issue');
  for (const b of report.bugs) {
    if (b.silent) {
      say(`  ${b.bug.padEnd(15)} ${String(b.affected).padStart(8)}  ${String(0).padStart(6)}  silent until a merchant rule catches it (pnpm sim:rescan)`);
      continue;
    }
    say(`  ${b.bug.padEnd(15)} ${String(b.affected).padStart(8)}  ${String(b.clusters).padStart(6)}  ${pct(b.recall).padStart(6)}  ${pct(b.precision).padStart(9)}   ${b.title ?? '-'}`);
  }
  say(`  clean sessions in an issue: ${report.clean_in_clusters.length}`);
  say(`  unexpected issues: ${report.unexpected_clusters.length}${report.unexpected_clusters.map((u) => `\n    - ${u.title} (${u.sessions} sessions)`).join('')}`);
  if (report.failed_sessions) say(`  left out of scoring (browser run failed): ${report.failed_sessions}`);
  say('');
  say('  abandonment (synthetic, sessions with a bag):');
  for (const a of report.abandonment) say(`    ${a.group.padEnd(15)} ${String(a.abandoned).padStart(4)} / ${String(a.with_cart).padEnd(4)} ${pct(a.rate)}`);

  // Phase 3: each bug's issue has a finding with a summary, repro steps, and a replay link that works.
  const findings = await waitForFindings(
    report.bugs.map((b) => b.cluster_id).filter((id): id is string => id !== null),
    findingsWaitS,
  );
  const phase3 = evaluateFindings(report.bugs, findings);
  for (const s of phase3.scores) {
    if (!s.replay_link) continue;
    const replay = await get<{ markers: { signal_id: string }[] }>(`/v1/sessions/${s.replay_link.session_id}/replay`).catch(() => null);
    if (!replay?.markers.some((m) => m.signal_id === s.replay_link!.signal_id)) phase3.failures.push(`${s.bug}: the replay link does not open the flagged moment`);
  }
  say('');
  say('  findings (synthetic revenue):');
  say('  bug             tier  steps  revenue at risk      finding');
  for (const s of phase3.scores) {
    const rar = s.revenue_status === 'ok' ? `${(s.revenue_at_risk_minor! / 100).toLocaleString('en-IN')} ${s.currency ?? ''}` : (s.revenue_status ?? '-');
    say(`  ${s.bug.padEnd(15)} ${String(s.tier ?? '-').padEnd(5)} ${String(s.repro_steps).padStart(5)}  ${rar.padEnd(19)}  ${s.title ?? '-'}`);
  }
  const offline = [...findings.values()].some((f) => f.model_version.includes('offline-stand-in'));
  if (offline) say('  (agents ran on the offline stand-in: set GOOGLE_API_KEY for Gemini)');
  report.failures.push(...phase3.failures);
  report.pass = report.pass && phase3.failures.length === 0;

  const reportFile = join(outDir, 'check-report.json');
  writeFileSync(reportFile, `${JSON.stringify({ ...report, findings: phase3.scores, seed: truth.seed, checked_at: Date.now(), min_recall: minRecall }, null, 2)}\n`);
  say('');
  say(`report: ${reportFile}`);
  if (!report.pass) {
    for (const f of report.failures) say(`  FAIL  ${f}`);
    say('FAIL: exit test not met (synthetic data)');
    process.exit(1);
  }
  say('PASS: each injected bug is one issue, no clean session is in any issue, and each issue has a finding with a summary, repro steps, and a working replay link (synthetic data)');
}

main().catch((err: unknown) => {
  say(`sim:check failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
