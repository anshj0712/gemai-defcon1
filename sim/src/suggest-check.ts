import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FindingRuleSuggestion, RevenueAtRisk, RuleDoc } from '@cp/schema';
import { arg, requireServices, say } from './browser.js';
import { SUGGESTED_RULE_BUGS } from './plan.js';
import { get, post, sleep, waitForFindings, waitForQuiet, type ClusterSummary } from './pipeline.js';
import { evaluate, evaluateRetro, pct, type ClusterLike, type GroundTruth } from './truth.js';

/**
 * `pnpm sim:suggest`: the exit test for agent-suggested rules, "the agent proposes a rule for a recurring
 * issue no rule explains, a person approves it, and the re-scan surfaces the sessions it already hurt".
 * Run it after `pnpm sim` (and `pnpm sim:check`), on a run with ghost_line sessions:
 *
 *   1. find the issue holding the ghost_line sessions (as sim:check does), then wait for a rule draft whose
 *      origin is the agent and whose cluster_id is that issue
 *   2. check its dry run: the agent drafts as soon as the issue qualifies (often mid-run), so the dry run is a
 *      snapshot. It must flag at least 90% of the ghost sessions that had ended before the draft, every
 *      sample from this run must be a ghost session, and the estimated revenue lost to date is above zero
 *   3. approve it (the same call the dashboard makes) and wait for the re-scan of the last 30 days
 *   4. check the new invariant issue anchored on the rule holds the ghost sessions (recall, precision: no clean
 *      session and no other bug's), and that the issue and its finding are tagged found later
 *
 * Writes sim/out/suggest-report.json. All sessions and numbers are synthetic.
 *
 *   pnpm sim:suggest [-- --wait 180] [--rescan-wait 300] [--min-recall 0.9] [--settle 8]
 */

const outDir = resolve(arg('out') ?? join('sim', 'out'));
const minRecall = Number(arg('min-recall') ?? 0.9);
/** A session's last chunk reaches raw storage within this long of the shopper leaving (SDK flush, collector). */
const INGEST_MARGIN_MS = 60_000;
const settleS = Number(arg('settle') ?? 8);
/** Seconds to wait for the agent to suggest a rule for the issue. */
const waitS = Number(arg('wait') ?? 180);
/** Seconds to wait for the re-scan after approval. */
const rescanWaitS = Number(arg('rescan-wait') ?? 300);

type RuleView = RuleDoc & { text: { active: string | null; draft: string | null } };
type FindingWithSuggestion = { rule_suggestion?: FindingRuleSuggestion };

const rupees = (r: Pick<RevenueAtRisk, 'revenue_at_risk_minor' | 'currency'>) => `${(r.revenue_at_risk_minor / 100).toLocaleString('en-IN')} ${r.currency ?? ''}`.trim();

async function main(): Promise<void> {
  const file = join(outDir, 'ground-truth.json');
  let truth: GroundTruth;
  try {
    truth = JSON.parse(readFileSync(file, 'utf8')) as GroundTruth;
  } catch {
    throw new Error(`no ground truth at ${file}. Run the simulator first: pnpm sim -- --sessions 120`);
  }
  const bug = SUGGESTED_RULE_BUGS[0]!;
  const ghost = new Set(truth.sessions.filter((s) => s.bug === bug && s.session_id && !s.error).map((s) => s.session_id!));
  const bugOf = new Map(truth.sessions.filter((s) => s.session_id && !s.error).map((s) => [s.session_id!, s.bug]));
  if (ghost.size === 0) throw new Error(`the last sim run has no ${bug} sessions; run more sessions (pnpm sim -- --sessions 120)`);
  await requireServices(['api']);
  const failures: string[] = [];

  // 1. The issue the ghost sessions collapsed into, then the agent's draft for it.
  say(`sim:suggest: ${ghost.size} synthetic ${bug} sessions; waiting for the pipeline to go quiet…`);
  const summaries = await waitForQuiet(settleS);
  const clusters = await Promise.all(summaries.map(async (s) => (await get<{ cluster: ClusterLike }>(`/v1/clusters/${s.cluster_id}?sessions=5000`)).cluster));
  const score = evaluate(truth, clusters, minRecall).bugs.find((b) => b.bug === bug)!;
  if (!score.cluster_id) throw new Error(`no issue holds the ${bug} sessions yet; check pnpm sim:check first`);
  const issueId = score.cluster_id;
  say(`  issue ${issueId} "${score.title}": ${pct(score.recall)} of the ${bug} sessions`);

  say(`  waiting up to ${waitS} s for the agent to suggest a rule for it…`);
  const deadline = Date.now() + waitS * 1000;
  let rule: RuleView | undefined;
  let lastSuggestion = '';
  for (;;) {
    const { rules } = await get<{ rules: RuleView[] }>('/v1/rules');
    rule = rules.find((r) => r.draft?.origin === 'agent' && r.draft.cluster_id === issueId);
    if (rule) break;
    const finding = await get<{ finding: FindingWithSuggestion }>(`/v1/findings/${issueId}`).then((r) => r.finding, () => null);
    const sg = finding?.rule_suggestion;
    const line = sg ? `${sg.status}${sg.rule_id ? ` ${sg.rule_id}` : ''}${sg.reason ? `: ${sg.reason}` : ''}` : '';
    if (line && line !== lastSuggestion) say(`  the suggester on this issue: ${line}`);
    lastSuggestion = line;
    if (sg?.status === 'drafted' && sg.rule_id) {
      const doc = rules.find((r) => r.rule_id === sg.rule_id);
      if (doc && !doc.draft) {
        throw new Error(`the agent drafted ${sg.rule_id} for this issue earlier and it was already ${doc.active ? 'approved' : 'discarded'}; start from a clean slate (pnpm clean, pnpm dev, pnpm sim) to test this lane`);
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`no agent-suggested draft for issue ${issueId} within ${waitS} s${lastSuggestion ? ` (last word from the suggester: ${lastSuggestion})` : ' (the suggester has not run on it: is the agent service running, and does the issue meet the trigger?)'}`);
    }
    await sleep(2000);
  }
  const d = rule.draft!;
  if (rule.active) throw new Error(`rule ${rule.rule_id} was approved before; start from a clean slate (pnpm clean, pnpm dev, pnpm sim) to test found later`);
  say(`  suggested: "${d.sentence}"`);
  say(`    by ${d.suggester ? (d.suggester.offline ? 'the offline stand-in (templated, not Gemini)' : d.suggester.model) : 'an unknown suggester'}; compiled by ${d.author.offline ? 'the offline stand-in' : d.author.model}`);
  if (d.suggester?.explanation) say(`    why: ${d.suggester.explanation}`);
  say(`  draft ${rule.rule_id} v${d.rule.version} "${rule.title}": ${rule.text.draft ?? '-'} (money in minor units)`);
  if (!d.suggester) failures.push('the agent draft has no suggester record (model, explanation)');

  // 2. The dry run and the revenue lost so far.
  const dr = d.dry_run;
  const samples = dr?.samples ?? [];
  const mine = samples.filter((s) => bugOf.has(s.session_id));
  const wrong = mine.filter((s) => !ghost.has(s.session_id));
  if (!dr) failures.push('the agent draft has no dry run');
  else {
    say(`  dry run: ${dr.sessions_scanned} sessions, applies to ${dr.sessions_applicable}, would flag ${dr.sessions_hit} (${pct(dr.hit_rate ?? 0)}); ${mine.length} of ${samples.length} samples are from this run`);
    // The agent drafts as soon as the issue qualifies, often while the simulator is still running, so the dry
    // run is a snapshot: it is held to the recall bar over the ghost sessions that had ended (with a minute for
    // their last chunk to arrive) before the draft was made. The re-scan's issue covers the rest (step 4).
    const settled = truth.sessions.filter((s) => s.session_id && ghost.has(s.session_id) && s.ended_at < d.created_at - INGEST_MARGIN_MS).length;
    if (dr.sessions_hit < 1) failures.push('the dry run flags no session');
    else if (dr.sessions_hit < Math.ceil(minRecall * settled)) failures.push(`the dry run flags ${dr.sessions_hit} sessions, fewer than ${pct(minRecall)} of the ${settled} ${bug} sessions that had ended before the draft`);
    if (settled < ghost.size) say(`    (drafted mid-run: ${settled} of this run's ${ghost.size} ${bug} sessions had ended by then; the re-scan covers the rest)`);
    if (wrong.length) failures.push(`the dry run's samples include ${wrong.length} session(s) of this run that are not ${bug}: ${wrong.map((s) => `${s.session_id} (${bugOf.get(s.session_id) ?? 'clean'})`).join(', ')}`);
  }
  const lost = d.revenue_lost;
  if (!lost) failures.push('the agent draft has no estimate of revenue lost to date');
  else if (lost.status !== 'ok') failures.push(`revenue lost to date is ${lost.status}: ${lost.note ?? 'no note'}`);
  else {
    const n = Number.isInteger(lost.affected_with_cart) ? String(lost.affected_with_cart) : lost.affected_with_cart.toFixed(1);
    say(`  estimated revenue lost to date: ${rupees(lost)} (synthetic): ${n} sessions with a cart × avg ${((lost.avg_cart_value_minor ?? 0) / 100).toLocaleString('en-IN')} × (${pct(lost.abandonment_affected ?? 0)} − ${pct(lost.abandonment_baseline ?? 0)})`);
    if (lost.revenue_at_risk_minor <= 0) failures.push('revenue lost to date is 0');
  }

  // 3. Approve, exactly as the dashboard does, and wait for the re-scan of this version.
  await post(`/v1/rules/${rule.rule_id}/approve`, { version: d.rule.version });
  say('  approved; re-scanning the last 30 days…');
  const ruleVersion = `${rule.rule_id}@${d.rule.version}`;
  const rescanDeadline = Date.now() + rescanWaitS * 1000;
  let doc: RuleView;
  for (;;) {
    doc = (await get<{ rule: RuleView }>(`/v1/rules/${rule.rule_id}`)).rule;
    if (doc.rescan && doc.rescan.rule_version === ruleVersion && doc.rescan.status !== 'running') break;
    if (Date.now() > rescanDeadline) throw new Error(`the re-scan did not finish within ${rescanWaitS} s`);
    await sleep(1000);
  }
  const rs = doc.rescan!;
  say(`  re-scan ${rs.status}: ${rs.sessions_scanned}/${rs.sessions_total} sessions, ${rs.sessions_hit} hit, ${rs.signals_written} signals written with their original times`);
  if (rs.status !== 'done') failures.push(`the re-scan ended ${rs.status}${rs.error ? `: ${rs.error}` : ''}`);

  // 4. The rule's own issue: the ghost sessions, nothing else from this run, found later.
  const quiet = await waitForQuiet(settleS);
  const issue: ClusterSummary | undefined = quiet.find((c) => c.kind === 'invariant' && c.anchor === rule.rule_id);
  let retro = null;
  let othersByGroup: Record<string, number> = {};
  let findingFoundLater = false;
  if (!issue) failures.push(`no issue holds the rule's hits (expected an invariant issue anchored on ${rule.rule_id})`);
  else {
    const { cluster } = await get<{ cluster: { sessions: string[]; found_later?: { sessions: number } } }>(`/v1/clusters/${issue.cluster_id}?sessions=5000`);
    retro = evaluateRetro(truth, bug, cluster.sessions);
    othersByGroup = cluster.sessions
      .filter((id) => bugOf.has(id) && !ghost.has(id))
      .reduce<Record<string, number>>((m, id) => ((m[bugOf.get(id) ?? 'clean'] = (m[bugOf.get(id) ?? 'clean'] ?? 0) + 1), m), {});
    say(`  issue ${issue.cluster_id}: recall ${pct(retro.recall)}, precision ${pct(retro.precision)}, ${cluster.found_later?.sessions ?? 0} sessions found later`);
    if (retro.recall < minRecall) failures.push(`${bug}: recall ${pct(retro.recall)} is below ${pct(minRecall)}`);
    if (othersByGroup.clean) failures.push(`the rule's issue holds ${othersByGroup.clean} clean session(s) of this run`);
    const otherBugs = Object.entries(othersByGroup).filter(([g]) => g !== 'clean');
    if (otherBugs.length) failures.push(`the rule's issue also holds other bugs' sessions (${otherBugs.map(([g, n]) => `${g} ${n}`).join(', ')}): broader than the defect it was suggested for`);
    if (!cluster.found_later?.sessions) failures.push('the issue has no sessions tagged found later');

    const findings = await waitForFindings([issue.cluster_id], 120, (f) => f.triage !== null && Boolean(f.discovery?.found_later));
    const f = findings.get(issue.cluster_id);
    findingFoundLater = Boolean(f?.discovery?.found_later);
    if (!f) failures.push("the rule's issue has no finding yet (is the agent service running?)");
    else if (!findingFoundLater) failures.push('the finding is not tagged found later');
    else say(`  finding: "${f.title}" (${f.tier}), found later: ${f.discovery!.found_later_sessions} sessions`);
  }

  const report = {
    synthetic: true,
    seed: truth.seed,
    bug,
    ghost_sessions: ghost.size,
    source_issue: { cluster_id: issueId, title: score.title, recall: score.recall, precision: score.precision },
    rule_id: rule.rule_id,
    rule_version: ruleVersion,
    sentence: d.sentence,
    rule_text: rule.text.draft,
    suggester: d.suggester && { model: d.suggester.model, offline: d.suggester.offline, explanation: d.suggester.explanation, assumptions: d.suggester.assumptions },
    author: { model: d.author.model, offline: d.author.offline },
    dry_run: dr && { sessions_scanned: dr.sessions_scanned, sessions_applicable: dr.sessions_applicable, sessions_hit: dr.sessions_hit, hit_rate: dr.hit_rate, samples_from_this_run: mine.length, samples_not_ghost: wrong.map((s) => s.session_id) },
    revenue_lost: lost,
    rescan: rs,
    rule_issue: issue ? { cluster_id: issue.cluster_id, ...retro, others_by_group: othersByGroup } : null,
    finding_found_later: findingFoundLater,
    pass: failures.length === 0,
    failures,
    checked_at: Date.now(),
  };
  const reportFile = join(outDir, 'suggest-report.json');
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  say('');
  say(`report: ${reportFile}`);
  if (failures.length) {
    for (const f of failures) say(`  FAIL  ${f}`);
    say('FAIL: agent-suggested rule exit test not met (synthetic data)');
    process.exit(1);
  }
  say('PASS: the agent suggested a rule for a recurring issue no rule explained, a person approved it, and the re-scan surfaced the sessions it already hurt, tagged found later (synthetic data)');
}

main().catch((err: unknown) => {
  say(`sim:suggest failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
