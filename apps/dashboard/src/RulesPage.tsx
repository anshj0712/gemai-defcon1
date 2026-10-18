import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { DryRun, RescanStatus, RevenueAtRisk } from '@cp/schema';
import { CheckIcon, CaretDownIcon, GearSixIcon, PencilSimpleIcon, PlayIcon, PlusIcon, BinocularsIcon, DetectiveIcon, ThumbsDownIcon, ArrowUUpLeftIcon, UserIcon } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ApiError, approveRule, draftRule, fetchClusters, fetchRules, redraftRule, rejectRule, rescanRule, runWatch, undoRule, type BuiltinRuleView, type ClusterSummary, type RuleView } from './api';
import { Eyebrow, Module, OriginChip, PageHeader, PageTabsList } from './components/common';
import { ago, formulaLine, money, pct, time } from './format';
import { probeValue } from './lib/probes';
import { liveOrigin } from './lib/rules';
import type { RulesTab } from './lib/route';
import { chanceText, CHURN_REASONS, watchSummary, watchValue } from './lib/watch';
import { ProbesPanel } from './ProbesPanel';

/** Example sentences. The first one finds the demo shop's silent quantity-price bug (synthetic data). */
export const EXAMPLES = [
  'No pair of shoes costs more than ₹17,000, so the bag subtotal must never be more than ₹17,000 times the number of pairs.',
  'The discount must never be more than 10% of the bag.',
  'The cart total must equal the line items minus the discount.',
  // A speed rule over a request probe (every network call is one, automatically).
  'Payment authorisation (req_post_api_payment_authorize_ms) must answer within 3 seconds.',
];

const REFRESH_MS = 2000;
const APPLIED_TOAST_MS = 20_000;
const LOST_HOW = 'Affected sessions with a cart × average cart × (their abandonment − baseline abandonment), over the sessions the dry run flags.';

/** "Model gemini-3.8-flash" or the offline stand-in, said plainly. */
function authorLine(a: { model: string; offline: boolean }): string {
  return a.offline ? 'Drafted by the offline stand-in (a template parser, not Gemini).' : `Drafted by ${a.model}`;
}

const ruleCode = (text: string) => (
  <p className="m-0 flex flex-wrap items-baseline gap-2">
    <code className="rounded-md border bg-muted px-2 py-1 text-[13px]">{text}</code>
    <span className="text-xs text-muted-foreground">(money in minor units)</span>
  </p>
);

const sentenceLine = (s: string) => <p className="m-0 text-sm text-muted-foreground italic">“{s}”</p>;

function ErrorNote({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertTitle>That did not work.</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}

/** The revenue-at-risk formula over the dry run's hits, shown inside a rule's details. */
function RevenueDetail({ r, at }: { r: RevenueAtRisk; at: number }) {
  if (r.status !== 'ok') return <p className="m-0 text-[13px] text-muted-foreground">Revenue lost: {r.note ?? 'not enough data yet'}.</p>;
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-danger-border bg-danger-muted px-3 py-2">
      <p className="m-0 text-sm">
        Estimated revenue lost to date: <b className="text-money tabular-nums">{money(r.revenue_at_risk_minor, r.currency)}</b> <span className="text-xs text-muted-foreground">as of {time(at)}</span>
      </p>
      <p className="m-0 text-xs text-muted-foreground">
        {LOST_HOW} {formulaLine(r)}
      </p>
    </div>
  );
}

/**
 * The two sides of a flagged snapshot. Probe values carry no unit, so whole numbers under 1,000 on both
 * sides are shown as counts (for example 1 pair against 2 lines): no amount in the shop is below ₹10.
 */
function sideText(left: number | null, right: number | null, currency: string | null, probe?: string): string {
  // Request probes carry milliseconds or an HTTP status, not money.
  if (probe && /_(ms|status)$/.test(probe)) return `${left === null ? '?' : probeValue(probe, left)} against ${right === null ? '?' : probeValue(probe, right)}`;
  const small = (v: number | null) => v === null || (Number.isInteger(v) && Math.abs(v) < 1000);
  if (small(left) && small(right)) return `${left ?? '?'} against ${right ?? '?'}`;
  return `${money(left, currency)} against ${money(right, currency)}`;
}

function DryRunBlock({ d, probe }: { d: DryRun; probe?: string | undefined }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-[13px]">
        Checked <b className="tabular-nums">{d.sessions_scanned}</b> recent session{d.sessions_scanned === 1 ? '' : 's'}
        {d.truncated ? ' (the newest; more exist)' : ''}. The rule applies to <b className="tabular-nums">{d.sessions_applicable}</b> and would flag <b className={cn('tabular-nums', d.sessions_hit > 0 && 'text-money')}>{d.sessions_hit}</b>
        {d.hit_rate !== null && <> ({pct(d.hit_rate)} of those it applies to)</>}. {d.hits_in_issues > 0 ? `${d.hits_in_issues} of them are already in an issue.` : 'None of them is in an issue yet.'}
      </p>
      {d.samples.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Page</TableHead>
              <TableHead title="Left side of the rule against its right side">Values</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Replay</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.samples.map((s) => (
              <TableRow key={s.session_id}>
                <TableCell className="tabular-nums">{time(s.event_time)}</TableCell>
                <TableCell className="font-mono text-xs">{s.route}</TableCell>
                <TableCell className="tabular-nums">{sideText(s.left, s.right, s.currency, probe)}</TableCell>
                <TableCell>{s.in_issue ? <Badge variant="secondary">In an issue</Badge> : <Badge className="bg-agent-muted text-agent">New</Badge>}</TableCell>
                <TableCell className="text-right">
                  <a className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'no-underline')} href={`#/sessions/${s.session_id}`}>
                    <PlayIcon data-icon="inline-start" aria-hidden="true" />
                    Watch replay
                  </a>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

const RESCAN_STATE: Record<string, string> = {
  running: 'bg-agent-muted text-agent',
  done: 'bg-success-muted text-success',
  failed: 'bg-danger-muted text-money',
  interrupted: 'bg-danger-muted text-money',
};

function RescanBlock({ s, issue, onRescan, busy }: { s: RescanStatus; issue: ClusterSummary | null; onRescan: () => void; busy: boolean }) {
  const pctDone = s.sessions_total > 0 ? Math.min(1, s.sessions_scanned / s.sessions_total) : s.status === 'running' ? 0 : 1;
  const days = Math.round((s.window.to - s.window.from) / 86_400_000);
  const bad = s.status === 'failed' || s.status === 'interrupted';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <b className="text-sm font-semibold">Re-scan of the last {days} days</b>
        <Badge className={RESCAN_STATE[s.status] ?? 'bg-muted text-muted-foreground'}>{s.status}</Badge>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(pctDone * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Re-scan progress">
        <span className={cn('block h-full rounded-full transition-[width]', bad ? 'bg-destructive' : 'bg-agent-strong')} style={{ width: `${pctDone * 100}%` }} />
      </div>
      <p className="m-0 text-[13px] text-muted-foreground">
        {s.sessions_scanned} of {s.sessions_total || '…'} sessions read{s.truncated ? ' (capped at the newest)' : ''} · <b className="text-foreground">{s.sessions_hit}</b> session{s.sessions_hit === 1 ? '' : 's'} hit · {s.signals_written} signal
        {s.signals_written === 1 ? '' : 's'} written with their original times
        {s.sessions_failed > 0 && <> · {s.sessions_failed} unreadable</>}
        {s.finished_at && <> · finished {ago(s.finished_at)}</>}
      </p>
      {s.error && <ErrorNote error={new Error(s.error)} />}
      <div className="flex flex-wrap gap-2">
        {issue && (
          <a className={cn(buttonVariants({ size: 'sm' }), 'no-underline')} href={`#/issues/${issue.cluster_id}`}>
            Open the issue ({issue.session_count} sessions)
          </a>
        )}
        {s.status !== 'running' && (
          <Button variant="outline" size="sm" disabled={busy} onClick={onRescan}>
            <BinocularsIcon data-icon="inline-start" aria-hidden="true" />
            Re-scan again
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * One rule as a compact row: who it is from, what it is, the one number that matters, and its actions. Everything else
 * (rates, the formula, the dry run, the reasoning) waits behind the chevron.
 */
function RuleRow({ chips, title, figure, actions, children, tone }: { chips: ReactNode; title: ReactNode; figure?: ReactNode; actions: ReactNode; children: ReactNode; tone?: 'agent' }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('rounded-xl bg-card ring-1 ring-border transition-shadow duration-200', tone === 'agent' && 'ring-agent-border', open && 'shadow-[0_10px_28px_-18px_rgb(15_23_42/0.35)]')}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">{chips}</div>
          <span className="text-[15px] leading-snug font-semibold">{title}</span>
        </div>
        {figure && <div className="text-right">{figure}</div>}
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={open ? 'Hide details' : 'Show details'} title={open ? 'Hide details' : 'Show details'}>
            <CaretDownIcon aria-hidden="true" className={cn('transition-transform duration-200 ease-out-expo', open && 'rotate-180')} />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="motion-reveal flex flex-col gap-3 border-t px-4 pt-3 pb-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const lostFigure = (r: RevenueAtRisk | null | undefined) =>
  r && r.status === 'ok' ? (
    <div className="flex flex-col">
      <span className="font-semibold text-money tabular-nums">{money(r.revenue_at_risk_minor, r.currency)}</span>
      <span className="text-xs text-muted-foreground">lost so far</span>
    </div>
  ) : null;

const CONFIDENCE: Record<string, string> = { high: 'bg-success-muted text-success', medium: 'bg-secondary text-secondary-foreground', low: 'bg-warn-muted text-warn' };

function HypStat({ value, label, tone }: { value: string; label: ReactNode; tone?: 'bad' }) {
  return (
    <div className={cn('flex flex-col gap-0.5 rounded-lg border px-3 py-2', tone === 'bad' ? 'border-danger-border bg-danger-muted' : 'bg-muted/50')}>
      <b className={cn('text-xl leading-tight font-semibold tabular-nums', tone === 'bad' && 'text-money')}>{value}</b>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

interface Actions {
  busy: string | null;
  errorFor: (r: RuleView) => Error | null;
  approve: (r: RuleView) => void;
  discard: (r: RuleView) => void;
  redraft: (r: RuleView, sentence: string) => void;
  reject: (r: RuleView, note: string) => void;
}

/** The churn watcher's hypothesis: visibly the agent's (dashed violet), never a finding until approved. */
function HypothesisRow({ r, a }: { r: RuleView; a: Actions }) {
  const d = r.draft!;
  const w = d.watch!;
  const [dialog, setDialog] = useState<'none' | 'edit' | 'reject'>('none');
  const [sentence, setSentence] = useState(d.sentence);
  const [note, setNote] = useState('');
  const page = w.feature.route ?? 'the store';
  const probe = d.proposed_probes?.[0] ?? null;
  const suggester = d.suggester;
  const closeDialog = (o: boolean) => !o && setDialog('none');
  const busyHere = (k: string) => a.busy === `${k}-${r.rule_id}`;
  return (
    <>
      <RuleRow
        tone="agent"
        chips={
          <>
            <OriginChip origin="agent" icon={DetectiveIcon}>
              Hypothesis · not a finding yet
            </OriginChip>
            <Badge variant="outline" className="border-warn-border bg-warn-muted text-warn">
              {CHURN_REASONS[w.churn_reason] ?? w.churn_reason}
            </Badge>
            <Badge className={CONFIDENCE[w.confidence] ?? CONFIDENCE.medium}>{w.confidence} confidence</Badge>
          </>
        }
        title={w.title}
        figure={lostFigure(d.revenue_lost)}
        actions={
          <>
            <Button size="sm" disabled={a.busy !== null} onClick={() => a.approve(r)}>
              <CheckIcon data-icon="inline-start" aria-hidden="true" />
              {busyHere('approve') ? 'Approving…' : probe ? 'Approve probe and rule' : 'Approve rule'}
            </Button>
            <Button size="sm" variant="outline" disabled={a.busy !== null} onClick={() => setDialog('edit')}>
              <PencilSimpleIcon data-icon="inline-start" aria-hidden="true" />
              {busyHere('redraft') ? 'Drafting again…' : 'Change the rule'}
            </Button>
            <Button size="sm" variant="outline" disabled={a.busy !== null} onClick={() => setDialog('reject')}>
              <ThumbsDownIcon data-icon="inline-start" aria-hidden="true" />
              {busyHere('reject') ? 'Telling the agent…' : 'Not a problem'}
            </Button>
          </>
        }
      >
        <div className="grid gap-2 md:grid-cols-3">
          <HypStat tone="bad" value={pct(w.segment.abandonment)} label={<>left without ordering after {w.feature.unit === 'ms' ? 'waiting' : 'seeing'} {w.direction === 'gte' ? '≥' : '≤'} {watchValue(w.feature.unit, w.threshold)} ({w.segment.sessions} sessions)</>} />
          <HypStat value={pct(w.baseline.abandonment)} label={<>of other shoppers who reached {page} left ({w.baseline.sessions})</>} />
          <HypStat value={`+${Math.round(w.lift * 100)} pts`} label={chanceText(w.p_value)} />
        </div>
        {d.revenue_lost && <RevenueDetail r={d.revenue_lost} at={d.created_at} />}
        <p className="m-0 text-sm">
          <b className="font-semibold">Why I think so:</b> {w.hypothesis}
        </p>
        <p className="m-0 text-[13px] leading-relaxed">
          {probe ? (
            <>
              <Badge className="mr-1 bg-agent-muted text-agent">New probe</Badge>
              <code>{probe.name}</code> reads <code>{probe.selector}</code> on {probe.routes?.join(', ') ?? 'every page'} as {probe.kind === 'money' ? 'money' : 'a number'}. Nobody probed it: the agent found it on the recorded pages. Approving registers
              it.
            </>
          ) : (
            <>
              <Badge variant="outline" className="mr-1">
                {w.feature.source === 'request' ? 'Request probe' : 'Probe'}
              </Badge>
              <code>{w.feature.name}</code> on {page}.
            </>
          )}{' '}
          <span className="text-muted-foreground">
            In the segment: {watchValue(w.feature.unit, w.values.segment_min)}
            {w.values.segment_max !== w.values.segment_min ? ` – ${watchValue(w.feature.unit, w.values.segment_max)}` : ''}; everyone else: up to {watchValue(w.feature.unit, w.values.others_max)}.
          </span>
        </p>
        {sentenceLine(d.sentence)}
        {ruleCode(r.text.draft ?? '')}
        <Eyebrow>Dry run (nothing written)</Eyebrow>
        {d.dry_run ? <DryRunBlock d={d.dry_run} probe={d.rule.highlight_probe} /> : <p className="m-0 text-muted-foreground">No dry run.</p>}
        <p className="m-0 text-xs text-muted-foreground">
          {suggester ? (suggester.offline ? 'Offline stand-in (templated)' : suggester.model) : 'Agent'} · found {ago(w.found_at)}. Nothing is flagged until you approve. Approving {probe ? 'registers the probe, ' : ''}runs the rule on live traffic, and re-scans the last 30 days.
        </p>
      </RuleRow>
      <ErrorNote error={a.errorFor(r)} />

      <Dialog open={dialog === 'edit'} onOpenChange={closeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change the rule</DialogTitle>
            <DialogDescription>
              Rewrite the sentence; the rule author drafts it again with a fresh dry run. Keep the probe name (<code>{probe?.name ?? w.feature.name}</code>) in the sentence.
            </DialogDescription>
          </DialogHeader>
          <Textarea rows={3} value={sentence} onChange={(e) => setSentence(e.target.value)} maxLength={500} aria-label="Rule sentence" />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              disabled={a.busy !== null || sentence.trim().length < 8}
              onClick={() => {
                setDialog('none');
                a.redraft(r, sentence);
              }}
            >
              Draft again
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'reject'} onOpenChange={closeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Not a problem?</DialogTitle>
            <DialogDescription>Say why it is expected. The agent reads your note next time and will not raise this number again unless the gap grows.</DialogDescription>
          </DialogHeader>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} aria-label="Why this is expected" placeholder="For example: express delivery costs ₹499 by design." />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={a.busy !== null}
              onClick={() => {
                setDialog('none');
                a.reject(r, note);
              }}
            >
              Discard and tell the agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A draft rule waiting for approval: one the agent suggested for a recurring issue, or one the merchant wrote. */
function DraftRow({ r, a }: { r: RuleView; a: Actions }) {
  const d = r.draft!;
  const agent = d.origin === 'agent';
  const suggester = d.suggester ?? null;
  return (
    <>
      <RuleRow
        tone={agent ? 'agent' : undefined}
        chips={
          <>
            {agent ? (
              <OriginChip origin="agent" icon={DetectiveIcon}>
                Suggested for a recurring issue
              </OriginChip>
            ) : (
              <OriginChip origin="human" icon={UserIcon}>
                Your draft
              </OriginChip>
            )}
            <Badge variant="outline">v{d.rule.version}</Badge>
          </>
        }
        title={d.rule.title}
        figure={lostFigure(d.revenue_lost)}
        actions={
          <>
            <Button size="sm" disabled={a.busy !== null} onClick={() => a.approve(r)}>
              <CheckIcon data-icon="inline-start" aria-hidden="true" />
              {a.busy === `approve-${r.rule_id}` ? 'Approving…' : 'Approve and re-scan'}
            </Button>
            <Button size="sm" variant="outline" disabled={a.busy !== null} onClick={() => a.discard(r)}>
              Discard
            </Button>
          </>
        }
      >
        {sentenceLine(d.sentence)}
        {agent && suggester?.explanation && (
          <p className="m-0 text-[13px]">
            <b className="font-semibold">Why:</b> {suggester.explanation}
          </p>
        )}
        {agent && suggester && suggester.assumptions.length > 0 && (
          <ul className="m-0 list-disc pl-5 text-[13px] text-muted-foreground">
            {suggester.assumptions.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
        {agent && d.cluster_id && (
          <p className="m-0 text-xs">
            <a href={`#/issues/${d.cluster_id}`}>Open the issue that prompted it</a>
          </p>
        )}
        {d.revenue_lost && <RevenueDetail r={d.revenue_lost} at={d.created_at} />}
        {ruleCode(r.text.draft ?? '')}
        {d.author.explanation && <p className="m-0 text-[13px]">{d.author.explanation}</p>}
        {d.author.assumptions.length > 0 && (
          <ul className="m-0 list-disc pl-5 text-[13px] text-muted-foreground">
            {d.author.assumptions.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
        <Eyebrow>Dry run (nothing written)</Eyebrow>
        {d.dry_run ? <DryRunBlock d={d.dry_run} probe={d.rule.highlight_probe} /> : <p className="m-0 text-muted-foreground">No dry run.</p>}
        <p className="m-0 text-xs text-muted-foreground">{authorLine(d.author)}</p>
      </RuleRow>
      <ErrorNote error={a.errorFor(r)} />
    </>
  );
}

/** A live rule: what it checks, who proposed it, and its re-scan; Undo switches it off. */
function LiveRow({ r, issue, busy, onUndo, onRescan }: { r: RuleView; issue: ClusterSummary | null; busy: boolean; onUndo: () => void; onRescan: () => void }) {
  const a = r.active!;
  const s = r.rescan;
  return (
    <RuleRow
      chips={
        <>
          <Badge className="bg-success-muted text-success">Live · v{a.rule.version}</Badge>
          {s && <Badge className={RESCAN_STATE[s.status] ?? 'bg-muted text-muted-foreground'}>re-scan {s.status}</Badge>}
          <span className="text-xs text-muted-foreground">
            approved {ago(a.approved_at)} by {a.approved_by}
          </span>
        </>
      }
      title={r.title}
      figure={
        s ? (
          <div className="flex flex-col">
            <span className="font-semibold text-agent tabular-nums">{s.sessions_hit}</span>
            <span className="text-xs text-muted-foreground">found in history</span>
          </div>
        ) : undefined
      }
      actions={
        <Button size="sm" variant="outline" disabled={busy} onClick={onUndo} title="Switch this rule off. What it already found stays as history.">
          <ArrowUUpLeftIcon data-icon="inline-start" aria-hidden="true" />
          Undo
        </Button>
      }
    >
      {sentenceLine(a.sentence)}
      <p className="m-0">
        <code className="rounded-md border bg-muted px-2 py-1 text-[13px]">{r.text.active}</code>
      </p>
      {s && <RescanBlock s={s} issue={issue} busy={busy} onRescan={onRescan} />}
      {a.author && <p className="m-0 text-xs text-muted-foreground">{authorLine(a.author)}</p>}
    </RuleRow>
  );
}

/**
 * Rules in plain English. Three tabs: what is waiting for approval, what is live, and the probes rules compare. In each,
 * what the agent proposed and what the merchant added are separate modules, so it is always clear whose idea a rule is.
 * Every rule is a compact row; its numbers open with the chevron.
 */
export function RulesPage({ tab }: { tab?: RulesTab }) {
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [builtin, setBuiltin] = useState<BuiltinRuleView[]>([]);
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const [sentence, setSentence] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  /** The action that failed, so a row shows its own error instead of the composer. */
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [watchNote, setWatchNote] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);

  const load = useCallback(
    () =>
      Promise.all([fetchRules(), fetchClusters().catch(() => ({ clusters: [] as ClusterSummary[] }))]).then(
        ([r, c]) => {
          setRules(r.rules);
          setBuiltin(r.builtin);
          setClusters(c.clusters);
          setLoadError(null);
        },
        (e: Error) => setLoadError(e.message),
      ),
    [],
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    setErrorKey(null);
    try {
      const res = (await fn()) as { rule?: { rule_id: string; title: string } } | undefined;
      // The rule just switched on: say so for a while, with an Undo.
      if (key.startsWith('approve-') && res?.rule) {
        const { rule_id, title } = res.rule;
        toast.success('Rule is live', {
          id: `applied-${rule_id}`,
          description: `${title}. It now checks every new session, and the last 30 days are being re-scanned. Changed your mind?`,
          duration: APPLIED_TOAST_MS,
          action: { label: 'Undo', onClick: () => void act(`undo-${rule_id}`, () => undoRule(rule_id)) },
        });
      }
      if (key.startsWith('undo-')) toast.dismiss(`applied-${key.slice('undo-'.length)}`);
      if (key === 'draft') {
        setWriting(false);
        setSentence('');
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setErrorKey(key);
    } finally {
      setBusy(null);
    }
  };

  const header = (
    <PageHeader
      title="Rules"
      description="What must always be true in your store. The agent proposes rules from what it sees; you approve them. An approved rule checks every new session and re-scans the last 30 days."
    />
  );

  if (loadError && !rules) {
    return (
      <>
        {header}
        <Alert variant="destructive">
          <AlertTitle>Could not load rules</AlertTitle>
          <AlertDescription>
            {loadError}. Is the API running? Try <code>pnpm dev</code>.
          </AlertDescription>
        </Alert>
      </>
    );
  }
  if (!rules) {
    return (
      <>
        {header}
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading rules">
          <Skeleton className="h-10 w-96 rounded-lg" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </>
    );
  }

  const issueFor = (ruleId: string) => clusters.find((c) => c.kind === 'invariant' && c.anchor === ruleId) ?? null;
  const drafts = rules.filter((r) => r.draft);
  const byLost = (a: RuleView, b: RuleView) => (b.draft?.revenue_lost?.revenue_at_risk_minor ?? 0) - (a.draft?.revenue_lost?.revenue_at_risk_minor ?? 0);
  // Drafts stored before origin existed have none: they are the merchant's.
  const agentDrafts = drafts.filter((r) => r.draft!.origin === 'agent').sort(byLost);
  const ownDrafts = drafts.filter((r) => r.draft!.origin !== 'agent');
  const live = rules.filter((r) => r.active);
  const liveAgent = live.filter((r) => liveOrigin(r) === 'agent');
  const liveOwn = live.filter((r) => liveOrigin(r) === 'human');
  const actions: Actions = {
    busy,
    errorFor: (r) => (['approve', 'reject', 'redraft'].some((k) => errorKey === `${k}-${r.rule_id}`) ? error : null),
    approve: (r) => void act(`approve-${r.rule_id}`, () => approveRule(r.rule_id, r.draft!.rule.version)),
    discard: (r) => void act(`reject-${r.rule_id}`, () => rejectRule(r.rule_id)),
    redraft: (r, s) => void act(`redraft-${r.rule_id}`, () => redraftRule(r.rule_id, s)),
    reject: (r, note) => void act(`reject-${r.rule_id}`, () => rejectRule(r.rule_id, note)),
  };
  const liveRow = (r: RuleView) => (
    <LiveRow
      key={r.rule_id}
      r={r}
      issue={issueFor(r.rule_id)}
      busy={busy !== null}
      onUndo={() => void act(`undo-${r.rule_id}`, () => undoRule(r.rule_id))}
      onRescan={() => void act(`rescan-${r.rule_id}`, () => rescanRule(r.rule_id))}
    />
  );
  const current = tab ?? 'waiting';
  const composerError = error && errorKey === 'draft' ? error : null;

  return (
    <>
      {header}
      <Tabs value={current} onValueChange={(v) => (window.location.hash = v === 'waiting' ? '#/rules' : `#/rules/${v}`)}>
        <PageTabsList>
          <TabsTrigger value="waiting">
            Waiting for approval <span className="text-muted-foreground tabular-nums">{drafts.length}</span>
          </TabsTrigger>
          <TabsTrigger value="live">
            Live rules <span className="text-muted-foreground tabular-nums">{live.length + builtin.length}</span>
          </TabsTrigger>
          <TabsTrigger value="probes">Probes</TabsTrigger>
        </PageTabsList>

        <TabsContent value="waiting" className="motion-reveal flex flex-col gap-4 pt-4">
          <Module
            id="agent-suspects"
            origin="agent"
            icon={DetectiveIcon}
            title="Suggested by the agent"
            count={agentDrafts.length}
            description="It watches every session for numbers shoppers leave over, and suggests rules for recurring issues. These are hypotheses: nothing is flagged until you approve."
            action={
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act('watch', async () => setWatchNote(watchSummary(await runWatch())))}>
                <BinocularsIcon data-icon="inline-start" aria-hidden="true" />
                {busy === 'watch' ? 'Looking…' : 'Look now'}
              </Button>
            }
          >
            {watchNote && <p className="m-0 text-[13px] text-muted-foreground">{watchNote}</p>}
            {agentDrafts.length === 0 ? (
              <p className="m-0 text-[13px] text-muted-foreground">Nothing suspected yet. The agent proposes a probe and a rule when shoppers who meet some number (a fee, a wait, a delivery estimate) leave far more often than everyone else.</p>
            ) : (
              agentDrafts.map((r) => (r.draft!.watch ? <HypothesisRow key={r.rule_id} r={r} a={actions} /> : <DraftRow key={r.rule_id} r={r} a={actions} />))
            )}
          </Module>

          <Module
            origin="human"
            icon={UserIcon}
            title="Your drafts"
            count={ownDrafts.length}
            description="Rules you wrote in plain English, with a dry run of what they would flag."
            action={
              <Button size="sm" onClick={() => setWriting(true)}>
                <PlusIcon data-icon="inline-start" aria-hidden="true" />
                Write a rule
              </Button>
            }
          >
            {ownDrafts.length === 0 ? (
              <p className="m-0 text-[13px] text-muted-foreground">No drafts. Write a rule in plain English, for example: “The discount must never be more than 10% of the bag.”</p>
            ) : (
              ownDrafts.map((r) => <DraftRow key={r.rule_id} r={r} a={actions} />)
            )}
          </Module>
        </TabsContent>

        <TabsContent value="live" className="motion-reveal flex flex-col gap-4 pt-4">
          <Module origin="agent" icon={DetectiveIcon} title="Proposed by the agent, approved by you" count={liveAgent.length} description="Rules the agent found and you switched on.">
            {liveAgent.length === 0 ? <p className="m-0 text-[13px] text-muted-foreground">None yet. Approve one of the agent's suggestions to see it here.</p> : liveAgent.map(liveRow)}
          </Module>
          <Module origin="human" icon={UserIcon} title="Added by you" count={liveOwn.length} description="Rules you wrote and approved.">
            {liveOwn.length === 0 ? <p className="m-0 text-[13px] text-muted-foreground">None yet.</p> : liveOwn.map(liveRow)}
          </Module>
          <Module origin="system" icon={GearSixIcon} title="Built in" count={builtin.length} description="Checks every store gets.">
            {builtin.map((b) => (
              <div key={b.rule_id} className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/30 px-4 py-3">
                <Badge variant="secondary">v{b.version}</Badge>
                <span className="font-semibold">{b.title}</span>
                <code className="ml-auto rounded-md border bg-card px-2 py-1 text-[13px]">{b.text}</code>
              </div>
            ))}
          </Module>
        </TabsContent>

        <TabsContent value="probes" className="motion-reveal pt-4">
          <ProbesPanel onChanged={() => void load()} />
        </TabsContent>
      </Tabs>

      <Dialog open={writing} onOpenChange={setWriting}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Write a rule</DialogTitle>
            <DialogDescription>Describe something that must always be true. Gemini turns it into a check over the numbers your sessions report, and a dry run shows what it would flag before anything goes live.</DialogDescription>
          </DialogHeader>
          <Textarea
            value={sentence}
            onChange={(e) => setSentence(e.target.value)}
            placeholder="For example: the discount must never be more than 10% of the bag."
            rows={3}
            maxLength={500}
            disabled={busy === 'draft'}
            aria-label="Rule in plain English"
          />
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <Button key={ex} variant="outline" size="xs" className="h-auto max-w-full py-1 text-left whitespace-normal" onClick={() => setSentence(ex)} disabled={busy === 'draft'}>
                {ex}
              </Button>
            ))}
          </div>
          {composerError && (
            <Alert variant="destructive">
              <AlertTitle>{composerError instanceof ApiError && composerError.code === 'not_understood' ? 'The rule author could not express this as a rule.' : 'That did not work.'}</AlertTitle>
              <AlertDescription>
                <span>{composerError.message}</span>
                {composerError instanceof ApiError && composerError.author && <span className="text-xs">{authorLine(composerError.author)}</span>}
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button disabled={busy !== null || sentence.trim().length < 8} onClick={() => void act('draft', () => draftRule(sentence))}>
              {busy === 'draft' ? 'Drafting… (rule author + dry run)' : 'Draft rule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
