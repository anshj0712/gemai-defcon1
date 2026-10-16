import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RuleDoc } from '@cp/schema';
import { arg, requireServices, say } from './browser.js';
import { WATCH_BUGS, type Bug } from './plan.js';
import { get, post, sleep, waitForFindings, waitForQuiet, type ClusterSummary } from './pipeline.js';
import { evaluateRetro, pct, type GroundTruth } from './truth.js';

/**
 * `pnpm sim:watch`: the exit test for the churn watcher, "the agent finds what makes shoppers leave on its own,
 * proposes a probe and a rule, a person approves, and the re-scan surfaces the sessions it already hurt".
 * Run it after `pnpm sim -- --sessions 240` (and `pnpm sim:check`), on a run with the four watch bugs:
 *
 *   1. wait for the pipeline to go quiet and the run's carts to settle (the abandonment window)
 *   2. ask the watcher to look (the same call as the dashboard's Look now) until each watch bug has a hypothesis
 *      whose segment is that bug's shoppers: precision 100% (only its shoppers from this run) and recall at least
 *      90% of its shoppers whose cart had settled when the hypothesis was found (the watcher also runs on its own
 *      timer, often mid-run; a hypothesis is a snapshot, and the re-scan's issue covers the rest)
 *   3. approve each, exactly as the dashboard does (registering the agent's proposed probe), and wait for re-scans
 *   4. each rule's issue holds the bug's sessions (recall >= 90%, precision 100%), tagged found later
 *
 * Other hypotheses (the watcher may also spot qty_price's inflated lines) are reported, not approved.
 * Writes sim/out/watch-report.json. All sessions and numbers are synthetic.
 *
 *   pnpm sim:watch [-- --wait 300] [--rescan-wait 300] [--min-recall 0.9] [--settle 8]
 */

const outDir = resolve(arg('out') ?? join('sim', 'out'));
const minRecall = Number(arg('min-recall') ?? 0.9);
const settleS = Number(arg('settle') ?? 8);
const waitS = Number(arg('wait') ?? 300);
const rescanWaitS = Number(arg('rescan-wait') ?? 300);
/** The agent's abandonment window (ABANDON_AFTER_IDLE_MS): a cart counts once it has been quiet this long. */
const ABANDON_WINDOW_MS = 120_000;
/** The window plus margin, waited after the run before asking the watcher. */
const SETTLE_CART_MS = Number(arg('cart-settle-ms') ?? 135_000);

type RuleView = RuleDoc & { text: { active: string | null; draft: string | null } };

interface Match {
  bug: Bug;
  rule: RuleView;
  precision: number;
  recall: number;
}

async function main(): Promise<void> {
  const file = join(outDir, 'ground-truth.json');
  let truth: GroundTruth;
  try {
    truth = JSON.parse(readFileSync(file, 'utf8')) as GroundTruth;
  } catch {
    throw new Error(`no ground truth at ${file}. Run the simulator first: pnpm sim -- --sessions 240`);
  }
  const scored = truth.sessions.filter((s) => s.session_id && !s.error);
  const bugOf = new Map(scored.map((s) => [s.session_id!, s.bug]));
  const affected = new Map(WATCH_BUGS.map((b) => [b, new Set(scored.filter((s) => s.bug === b).map((s) => s.session_id!))]));
  const withCart = new Map(WATCH_BUGS.map((b) => [b, new Set(scored.filter((s) => s.bug === b && s.has_cart).map((s) => s.session_id!))]));
  for (const [b, set] of affected) if (set.size === 0) throw new Error(`the last sim run has no ${b} sessions; run more sessions (pnpm sim -- --sessions 240)`);
  await requireServices(['api']);
  const failures: string[] = [];

  say(`sim:watch: ${WATCH_BUGS.map((b) => `${affected.get(b)!.size} ${b}`).join(', ')} synthetic sessions should be silent until the agent proposes a probe and rule`);
  await waitForQuiet(settleS);
  const settleAt = truth.finished_at + SETTLE_CART_MS;
  if (Date.now() < settleAt) {
    say(`  waiting ${Math.ceil((settleAt - Date.now()) / 1000)} s for the run's carts to settle (the abandonment window)…`);
    await sleep(settleAt - Date.now());
  }

  // 2. Look until every watch bug has a hypothesis whose segment is its shoppers.
  say(`  asking the churn watcher to look (up to ${waitS} s)…`);
  const deadline = Date.now() + waitS * 1000;
  const matches = new Map<Bug, Match>();
  let rules: RuleView[] = [];
  for (;;) {
    const pass = await post<{ results: { sessions: number; decided: number; numbers: number; candidates: { feature_key: string; outcome: string; reason: string | null }[] } }>('/v1/watch/run', {});
    const r = pass.results;
    for (const c of r.candidates) say(`    ${c.outcome}: ${c.feature_key}${c.reason ? ` (${c.reason.slice(0, 120)})` : ''}`);
    rules = (await get<{ rules: RuleView[] }>('/v1/rules')).rules;
    for (const rule of rules) {
      const w = rule.draft?.watch;
      if (!w) continue;
      const mine = w.session_ids.filter((id) => bugOf.has(id));
      for (const b of WATCH_BUGS) {
        const hits = mine.filter((id) => affected.get(b)!.has(id)).length;
        if (hits === 0) continue;
        const precision = mine.length ? hits / mine.length : 0;
        // A hypothesis is a snapshot: judged against the bug's shoppers whose carts had settled when it was found.
        // The re-scan's issue (step 4) is judged against all of them.
        const settled = scored.filter((s) => s.bug === b && s.has_cart && s.ended_at + ABANDON_WINDOW_MS <= w.found_at).length;
        const recall = Math.min(1, hits / Math.max(1, settled || withCart.get(b)!.size));
        const prev = matches.get(b);
        if (!prev || recall > prev.recall) matches.set(b, { bug: b, rule, precision, recall });
      }
    }
    if (WATCH_BUGS.every((b) => matches.has(b)) || Date.now() > deadline) break;
    say(`    (${r.sessions} sessions, ${r.decided} settled carts, ${r.numbers} numbers; hypotheses so far for ${[...matches.keys()].join(', ') || 'none'}); looking again…`);
    await sleep(5000);
  }
  for (const b of WATCH_BUGS) {
    const m = matches.get(b);
    if (!m) {
      failures.push(`${b}: the watcher raised no hypothesis whose segment holds its shoppers`);
      continue;
    }
    const w = m.rule.draft!.watch!;
    say(`  ${b}: "${w.title}" [${w.churn_reason}, ${w.confidence}] on ${w.feature.name} (${w.feature.source}${w.feature.selector ? ` ${w.feature.selector}` : ''})`);
    say(`    ${pct(w.segment.abandonment)} of ${w.segment.sessions} left vs ${pct(w.baseline.abandonment)} of ${w.baseline.sessions}; segment precision ${pct(m.precision)}, recall ${pct(m.recall)}`);
    say(`    rule: "${m.rule.draft!.sentence}" -> ${m.rule.text.draft}${m.rule.draft!.proposed_probes?.length ? ` (new probe ${m.rule.draft!.proposed_probes[0]!.name})` : ''}`);
    if (m.precision < 1) failures.push(`${b}: the hypothesis segment holds other shoppers of this run (precision ${pct(m.precision)})`);
    if (m.recall < minRecall) failures.push(`${b}: the hypothesis segment holds ${pct(m.recall)} of its shoppers whose cart had settled, below ${pct(minRecall)}`);
  }
  const extras = rules.filter((r) => r.draft?.watch && ![...matches.values()].some((m) => m.rule.rule_id === r.rule_id));
  for (const r of extras) say(`  also suspected (not approved here): "${r.draft!.watch!.title}" on ${r.draft!.watch!.feature.name}`);

  // 3. Approve each matched hypothesis, as the dashboard does, then wait for its re-scan.
  const results: Record<string, unknown>[] = [];
  for (const m of matches.values()) {
    const d = m.rule.draft!;
    await post(`/v1/rules/${m.rule.rule_id}/approve`, { version: d.rule.version });
    say(`  approved ${m.rule.rule_id} v${d.rule.version}${d.proposed_probes?.length ? ` with probe ${d.proposed_probes[0]!.name}` : ''}; re-scanning…`);
  }
  for (const m of matches.values()) {
    const version = `${m.rule.rule_id}@${m.rule.draft!.rule.version}`;
    const until = Date.now() + rescanWaitS * 1000;
    let doc: RuleView;
    for (;;) {
      doc = (await get<{ rule: RuleView }>(`/v1/rules/${m.rule.rule_id}`)).rule;
      if (doc.rescan && doc.rescan.rule_version === version && doc.rescan.status !== 'running') break;
      if (Date.now() > until) throw new Error(`the re-scan of ${version} did not finish within ${rescanWaitS} s`);
      await sleep(1000);
    }
    if (doc.rescan!.status !== 'done') failures.push(`${m.bug}: the re-scan ended ${doc.rescan!.status}`);
  }

  // 4. Each rule's own issue: the bug's sessions, nothing else from this run, found later.
  const quiet = await waitForQuiet(settleS);
  for (const m of matches.values()) {
    const issue: ClusterSummary | undefined = quiet.find((c) => c.kind === 'invariant' && c.anchor === m.rule.rule_id);
    if (!issue) {
      failures.push(`${m.bug}: no issue holds the approved rule's hits`);
      continue;
    }
    const { cluster } = await get<{ cluster: { sessions: string[]; found_later?: { sessions: number } } }>(`/v1/clusters/${issue.cluster_id}?sessions=5000`);
    const retro = evaluateRetro(truth, m.bug, cluster.sessions);
    say(`  ${m.bug}: issue ${issue.cluster_id}: recall ${pct(retro.recall)}, precision ${pct(retro.precision)}, ${cluster.found_later?.sessions ?? 0} found later`);
    if (retro.recall < minRecall) failures.push(`${m.bug}: issue recall ${pct(retro.recall)} is below ${pct(minRecall)}`);
    if (retro.precision < 1) failures.push(`${m.bug}: the issue holds ${retro.others} session(s) of this run that are not ${m.bug}`);
    if (!cluster.found_later?.sessions) failures.push(`${m.bug}: the issue has no sessions tagged found later`);
    results.push({ bug: m.bug, rule_id: m.rule.rule_id, sentence: m.rule.draft!.sentence, rule_text: m.rule.text.draft, watch: m.rule.draft!.watch, segment_precision: m.precision, segment_recall: m.recall, issue: { cluster_id: issue.cluster_id, ...retro, found_later: cluster.found_later?.sessions ?? 0 } });
  }
  const issueIds = results.map((r) => (r.issue as { cluster_id: string }).cluster_id);
  if (issueIds.length) {
    const findings = await waitForFindings(issueIds, 120, (f) => f.triage !== null && Boolean(f.discovery?.found_later));
    for (const id of issueIds) if (!findings.get(id)?.discovery?.found_later) failures.push(`the finding for issue ${id} is not tagged found later yet`);
  }

  const report = { synthetic: true, seed: truth.seed, watch_bugs: WATCH_BUGS, results, extras: extras.map((r) => ({ rule_id: r.rule_id, title: r.draft!.watch!.title, feature: r.draft!.watch!.feature })), pass: failures.length === 0, failures, checked_at: Date.now() };
  const reportFile = join(outDir, 'watch-report.json');
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  say('');
  say(`report: ${reportFile}`);
  if (failures.length) {
    say('FAIL:');
    for (const f of failures) say(`  - ${f}`);
    process.exit(1);
  }
  say('PASS: the agent found each churn bug on its own, a person approved its probe and rule, and the re-scan surfaced the sessions it already hurt (synthetic data)');
}

main().catch((err: unknown) => {
  say(`sim:watch failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
