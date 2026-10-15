import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arg, requireServices, say } from './browser.js';
import { RETRO_BUGS, RETRO_RULE_SENTENCE } from './plan.js';
import { get, post, sleep, waitForFindings, waitForQuiet, type ClusterSummary } from './pipeline.js';
import { evaluateRetro, pct, type GroundTruth } from './truth.js';

/**
 * `pnpm sim:rescan`: the Phase 4 exit test, "adding a rule surfaces past sessions tagged found later".
 * Run it after `pnpm sim` (and `pnpm sim:check`, which passes with the retro bug silent):
 *
 *   1. wait for the pipeline to go quiet and every issue to have a finding; note the time T
 *   2. draft a rule from a merchant sentence (rule author + dry run), then approve it
 *   3. wait for the re-scan of past sessions to finish and the new issue's finding to appear
 *   4. check the retro bug's sessions collapsed into that one issue (recall, precision), tagged found later
 *   5. time travel: as of T the issue was not on record; now, for the same stretch, it is, and it is the
 *      only finding the two answers differ by
 *
 * Writes sim/out/rescan-report.json. All sessions and numbers are synthetic.
 *
 *   pnpm sim:rescan [-- --sentence "<rule>"] [--min-recall 0.9] [--settle 8] [--wait 300]
 */

const outDir = resolve(arg('out') ?? join('sim', 'out'));
const sentence = arg('sentence') ?? RETRO_RULE_SENTENCE;
const minRecall = Number(arg('min-recall') ?? 0.9);
const settleS = Number(arg('settle') ?? 8);
const waitS = Number(arg('wait') ?? 300);

interface RuleDocLike {
  rule_id: string;
  title: string;
  active: { rule: { version: number } } | null;
  draft: { rule: { version: number }; author: { model: string; offline: boolean }; dry_run: { sessions_scanned: number; sessions_applicable: number; sessions_hit: number; hit_rate: number | null } | null } | null;
  rescan: { rescan_id: string; status: string; sessions_total: number; sessions_scanned: number; sessions_hit: number; signals_written: number; error: string | null } | null;
}

interface HistoryLike {
  then: { finding_id: string }[];
  current: { finding_id: string; found_later_sessions: number }[];
  found_later: string[];
}

async function main(): Promise<void> {
  const file = join(outDir, 'ground-truth.json');
  let truth: GroundTruth;
  try {
    truth = JSON.parse(readFileSync(file, 'utf8')) as GroundTruth;
  } catch {
    throw new Error(`no ground truth at ${file}. Run the simulator first: pnpm sim -- --sessions 120`);
  }
  const bug = RETRO_BUGS[0]!;
  const affected = truth.sessions.filter((s) => s.bug === bug && s.session_id && !s.error).length;
  if (affected === 0) throw new Error(`the last sim run has no ${bug} sessions; run more sessions (pnpm sim -- --sessions 120)`);
  await requireServices(['api']);
  const failures: string[] = [];

  say(`sim:rescan: ${affected} synthetic ${bug} sessions should be silent until a merchant rule catches them; waiting for the pipeline to go quiet…`);
  const before = await waitForQuiet(settleS);
  await waitForFindings(
    before.map((c) => c.cluster_id),
    60,
  );
  const T = Date.now();

  say(`  drafting: "${sentence}"`);
  const { rule: draft } = await post<{ rule: RuleDocLike }>('/v1/rules/draft', { sentence });
  if (draft.active) throw new Error(`rule ${draft.rule_id} was approved before; start from a clean slate (pnpm clean, pnpm dev, pnpm sim) to test found later`);
  const d = draft.draft!;
  say(`  draft ${draft.rule_id} v${d.rule.version} by ${d.author.offline ? 'the offline stand-in' : d.author.model}: "${draft.title}"`);
  if (d.dry_run) say(`  dry run: ${d.dry_run.sessions_scanned} sessions, applies to ${d.dry_run.sessions_applicable}, would flag ${d.dry_run.sessions_hit} (${pct(d.dry_run.hit_rate ?? 0)})`);
  if (!d.dry_run?.sessions_hit) failures.push('the dry run flags no session');

  await post('/v1/rules/' + draft.rule_id + '/approve', { version: d.rule.version });
  say('  approved; re-scanning the last 30 days…');
  const deadline = Date.now() + waitS * 1000;
  let doc: RuleDocLike;
  for (;;) {
    doc = (await get<{ rule: RuleDocLike }>(`/v1/rules/${draft.rule_id}`)).rule;
    if (doc.rescan && doc.rescan.status !== 'running') break;
    if (Date.now() > deadline) throw new Error(`the re-scan did not finish within ${waitS} s`);
    await sleep(1000);
  }
  const rs = doc.rescan!;
  say(`  re-scan ${rs.status}: ${rs.sessions_scanned}/${rs.sessions_total} sessions, ${rs.sessions_hit} hit, ${rs.signals_written} signals written with their original times`);
  if (rs.status !== 'done') failures.push(`the re-scan ended ${rs.status}${rs.error ? `: ${rs.error}` : ''}`);

  const quiet = await waitForQuiet(settleS);
  const issue: ClusterSummary | undefined = quiet.find((c) => c.kind === 'invariant' && c.anchor === draft.rule_id);
  let retro = null;
  let findingFoundLater = false;
  let history: HistoryLike | null = null;
  if (!issue) failures.push(`no issue holds the rule's hits (expected an invariant issue anchored on ${draft.rule_id})`);
  else {
    const { cluster } = await get<{ cluster: { sessions: string[]; found_later?: { sessions: number } } }>(`/v1/clusters/${issue.cluster_id}?sessions=5000`);
    retro = evaluateRetro(truth, bug, cluster.sessions);
    say(`  issue ${issue.cluster_id}: recall ${pct(retro.recall)}, precision ${pct(retro.precision)}, ${cluster.found_later?.sessions ?? 0} sessions found later`);
    if (retro.recall < minRecall) failures.push(`${bug}: recall ${pct(retro.recall)} is below ${pct(minRecall)}`);
    if (retro.precision < 1) failures.push(`${bug}: precision ${pct(retro.precision)} (${retro.others} other sessions in the issue)`);
    if (!cluster.found_later?.sessions) failures.push('the issue has no sessions tagged found later');

    const findings = await waitForFindings([issue.cluster_id], 120, (f) => f.triage !== null && Boolean(f.discovery?.found_later));
    const f = findings.get(issue.cluster_id);
    findingFoundLater = Boolean(f?.discovery?.found_later);
    if (!f) failures.push("the rule's issue has no finding yet (is the agent service running?)");
    else if (!findingFoundLater) failures.push('the finding is not tagged found later');
    else say(`  finding: "${f.title}" (${f.tier}), found later: ${f.discovery!.found_later_sessions} sessions`);

    // Time travel over the run's stretch of activity: what we believed at T, against what we know now.
    const from = truth.started_at - 60_000;
    history = await get<HistoryLike>(`/v1/history?as_of=${T}&from=${from}&to=${T}`);
    const thenHas = history.then.some((x) => x.finding_id === issue.cluster_id);
    const nowHas = history.current.some((x) => x.finding_id === issue.cluster_id);
    say(`  as of T: ${history.then.length} issues on record; now, same stretch: ${history.current.length}; found later: ${history.found_later.length}`);
    if (thenHas) failures.push('as of T the issue was already on record (it should have been found later)');
    if (!nowHas) failures.push('the current record has no finding for the issue in that stretch');
    if (history.found_later.length !== 1 || history.found_later[0] !== issue.cluster_id) {
      failures.push(`found later should be exactly the rule's issue; got [${history.found_later.join(', ')}]`);
    }
  }

  const report = { synthetic: true, seed: truth.seed, sentence, rule_id: draft.rule_id, as_of: T, rescan: rs, retro, finding_found_later: findingFoundLater, history: history && { then: history.then.length, current: history.current.length, found_later: history.found_later }, pass: failures.length === 0, failures, checked_at: Date.now() };
  const reportFile = join(outDir, 'rescan-report.json');
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  say('');
  say(`report: ${reportFile}`);
  if (failures.length) {
    for (const f of failures) say(`  FAIL  ${f}`);
    say('FAIL: Phase 4 exit test not met (synthetic data)');
    process.exit(1);
  }
  say('PASS: the new rule surfaced past sessions of a bug no rule saw at the time, tagged found later, and time travel shows the difference (synthetic data)');
}

main().catch((err: unknown) => {
  say(`sim:rescan failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
