import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { DryRun, RescanStatus, RevenueAtRisk } from '@cp/schema';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, PencilIcon, PlayIcon, ScanSearchIcon, SparklesIcon, ThumbsDownIcon, Undo2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ApiError, approveRule, draftRule, fetchClusters, fetchRules, redraftRule, rejectRule, rescanRule, runWatch, undoRule, type BuiltinRuleView, type ClusterSummary, type RuleView } from './api';
import { Eyebrow, PageHeader, SyntheticNote } from './components/common';
import { ago, formulaLine, money, pct, time } from './format';
import { probeValue } from './lib/probes';
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

/** "Model gemini-3.8-flash" or the offline stand-in, said plainly. */
function authorLine(a: { model: string; offline: boolean }): string {
  return a.offline ? 'Drafted by the offline stand-in (a template parser, not Gemini). Set GOOGLE_API_KEY for Gemini.' : `Drafted by ${a.model}`;
}

/** Who worded an agent suggestion: Gemini, or the offline stand-in, said plainly. */
function suggesterLine(s: { model: string; offline: boolean }): string {
  return s.offline ? 'Suggested by the offline stand-in (templated, not Gemini). Set GOOGLE_API_KEY for Gemini.' : `Suggested by ${s.model}`;
}

const LOST_HOW = 'Affected sessions with a cart × average cart × (their abandonment − baseline abandonment), over the sessions the dry run flags.';

const SectionTitle = ({ children, id }: { children: ReactNode; id?: string }) => (
  <h2 id={id} className="m-0 text-lg font-semibold tracking-tight">
    {children}
  </h2>
);

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

/**
 * Revenue already lost to the pattern: the revenue-at-risk formula over the dry run's hits. Prominent on an
 * agent suggestion (it is why the suggestion matters), one compact line on a merchant's own draft.
 */
function RevenueLost({ r, prominent, at }: { r: RevenueAtRisk; prominent: boolean; at: number }) {
  const ok = r.status === 'ok';
  // Computed once, when the draft and its dry run were made; it does not move with later sessions.
  const asOf = <span className="text-xs text-muted-foreground">as of {time(at)}</span>;
  if (!prominent) {
    return (
      <p className="m-0 flex flex-wrap items-center gap-2 text-[13px]" title={ok ? `${LOST_HOW} ${formulaLine(r)}` : undefined}>
        Estimated revenue lost to date: {ok ? <b className="text-money tabular-nums">{money(r.revenue_at_risk_minor, r.currency)}</b> : <span className="text-muted-foreground">{r.note ?? 'not enough data yet'}</span>} {asOf}
        <SyntheticNote />
      </p>
    );
  }
  return (
    <div className={cn('flex flex-col gap-1 rounded-lg border px-3 py-2', ok ? 'border-danger-border bg-danger-muted' : 'bg-muted')}>
      <p className="m-0 flex flex-wrap items-center gap-2 text-sm">
        Estimated revenue lost to date: {ok ? <b className="text-lg text-money tabular-nums">{money(r.revenue_at_risk_minor, r.currency)}</b> : <span className="text-muted-foreground">not enough data yet</span>} {asOf}
        <SyntheticNote />
      </p>
      {ok ? (
        <p className="m-0 text-xs text-muted-foreground" title={formulaLine(r)}>
          {LOST_HOW} {formulaLine(r)}
        </p>
      ) : (
        r.note && <p className="m-0 text-xs text-muted-foreground">{r.note}</p>
      )}
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

function dryRunLine(d: DryRun): ReactNode {
  return (
    <>
      Checked <b className="tabular-nums">{d.sessions_scanned}</b> recent session{d.sessions_scanned === 1 ? '' : 's'}
      {d.truncated ? ' (the newest; more exist)' : ''}. The rule applies to <b className="tabular-nums">{d.sessions_applicable}</b> and would flag <b className={cn('tabular-nums', d.sessions_hit > 0 && 'text-money')}>{d.sessions_hit}</b>
      {d.hit_rate !== null && <> ({pct(d.hit_rate)} of those it applies to)</>}. {d.hits_in_issues > 0 ? `${d.hits_in_issues} of them are already in an issue.` : 'None of them is in an issue yet.'}
    </>
  );
}

function DryRunBlock({ d, probe }: { d: DryRun; probe?: string | undefined }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-[13px]">{dryRunLine(d)}</p>
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
    <div className="flex flex-col gap-2 border-t pt-3">
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
            <ScanSearchIcon data-icon="inline-start" aria-hidden="true" />
            Re-scan again
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * A pending draft: the merchant's own, or one the agent suggested for a recurring issue. Both have the same
 * dry run and the same two actions; approving is the only thing that makes either live and starts a re-scan.
 */
function DraftCard({ r, busy, error, onApprove, onDiscard }: { r: RuleView; busy: string | null; error: Error | null; onApprove: () => void; onDiscard: () => void }) {
  const d = r.draft!;
  const agent = d.origin === 'agent';
  const suggester = d.suggester ?? null;
  const lost = d.revenue_lost ?? null;
  return (
    <Card className={cn('gap-3 px-5', agent ? 'ring-agent-border' : 'ring-info-border')}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge className="bg-info-muted text-info">Draft · v{d.rule.version}</Badge>
        {agent && (
          <Badge className="bg-agent-muted text-agent">
            <SparklesIcon data-icon="inline-start" aria-hidden="true" />
            Suggested by the agent
          </Badge>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{authorLine(d.author)}</span>
      </div>
      <h3 className="m-0 text-base font-semibold">{d.rule.title}</h3>
      {sentenceLine(d.sentence)}
      {agent && (
        <>
          {suggester?.explanation && (
            <p className="m-0 text-[13px]">
              <b className="font-semibold">Why:</b> {suggester.explanation}
            </p>
          )}
          {suggester && suggester.assumptions.length > 0 && (
            <ul className="m-0 list-disc pl-5 text-[13px] text-muted-foreground">
              {suggester.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
          <p className="m-0 text-xs text-muted-foreground">
            {suggester ? suggesterLine(suggester) : 'Suggested by the agent'}
            {d.cluster_id && (
              <>
                {' · '}
                <a href={`#/issues/${d.cluster_id}`}>Open the issue that prompted it</a>
              </>
            )}
          </p>
          {lost && <RevenueLost r={lost} prominent at={d.created_at} />}
        </>
      )}
      {ruleCode(r.text.draft ?? '')}
      {d.author.explanation && <p className="m-0 text-[13px]">{d.author.explanation}</p>}
      {d.author.assumptions.length > 0 && (
        <ul className="m-0 list-disc pl-5 text-[13px] text-muted-foreground">
          {d.author.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
      <Eyebrow>Dry run (nothing written)</Eyebrow>
      {d.dry_run ? <DryRunBlock d={d.dry_run} probe={d.rule.highlight_probe} /> : <p className="m-0 text-muted-foreground">No dry run.</p>}
      {!agent && lost && <RevenueLost r={lost} prominent={false} at={d.created_at} />}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy !== null} onClick={onApprove}>
          <CheckIcon data-icon="inline-start" aria-hidden="true" />
          {busy === `approve-${r.rule_id}` ? 'Approving…' : 'Approve and re-scan the last 30 days'}
        </Button>
        <Button variant="outline" disabled={busy !== null} onClick={onDiscard}>
          Discard
        </Button>
      </div>
      <ErrorNote error={error} />
    </Card>
  );
}

const CONFIDENCE: Record<string, string> = { high: 'bg-success-muted text-success', medium: 'bg-secondary text-secondary-foreground', low: 'bg-warn-muted text-warn' };

/** One of the hypothesis's three numbers: a big figure and what it means. */
function HypStat({ value, label, tone }: { value: string; label: ReactNode; tone?: 'bad' }) {
  return (
    <div className={cn('flex flex-col gap-0.5 rounded-lg border px-3 py-2', tone === 'bad' ? 'border-danger-border bg-danger-muted' : 'bg-muted/50')}>
      <b className={cn('text-xl leading-tight font-semibold tabular-nums', tone === 'bad' && 'text-money')}>{value}</b>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

/**
 * The churn watcher's hypothesis: a number code found that shoppers leave over, the agent's reading of it, the
 * probe and rule it proposes, and the dry run. Visibly not a finding (dashed violet): nothing is flagged until a
 * person approves, changes the rule, or says it is not a problem (the agent reads that note next time).
 * Compact by default; "Show evidence" opens the reasoning, the probe and the dry run's sessions.
 */
function HypothesisCard({
  r,
  busy,
  error,
  onApprove,
  onRedraft,
  onReject,
}: {
  r: RuleView;
  busy: string | null;
  error: Error | null;
  onApprove: () => void;
  onRedraft: (sentence: string) => void;
  onReject: (note: string) => void;
}) {
  const d = r.draft!;
  const w = d.watch!;
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'none' | 'edit' | 'reject'>('none');
  const [sentence, setSentence] = useState(d.sentence);
  const [note, setNote] = useState('');
  const page = w.feature.route ?? 'the store';
  const probe = d.proposed_probes?.[0] ?? null;
  const suggester = d.suggester;
  const closeDialog = (o: boolean) => !o && setDialog('none');
  return (
    <Card className="gap-3 border border-dashed border-agent-border px-5 ring-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge className="bg-agent-muted text-agent">
          <SparklesIcon data-icon="inline-start" aria-hidden="true" />
          Hypothesis · not a finding yet
        </Badge>
        <Badge variant="outline" className="border-warn-border bg-warn-muted text-warn">
          {CHURN_REASONS[w.churn_reason] ?? w.churn_reason}
        </Badge>
        <Badge className={CONFIDENCE[w.confidence] ?? CONFIDENCE.medium}>{w.confidence} confidence</Badge>
        <span className="ml-auto text-xs text-muted-foreground">
          {suggester ? (suggester.offline ? 'offline stand-in (templated)' : suggester.model) : 'agent'} · found {ago(w.found_at)}
        </span>
      </div>
      <h3 className="m-0 text-base font-semibold">{w.title}</h3>
      <div className="grid gap-2 md:grid-cols-3">
        <HypStat
          tone="bad"
          value={pct(w.segment.abandonment)}
          label={
            <>
              left without ordering after {w.feature.unit === 'ms' ? 'waiting' : 'seeing'} {w.direction === 'gte' ? '≥' : '≤'} {watchValue(w.feature.unit, w.threshold)} ({w.segment.sessions} sessions)
            </>
          }
        />
        <HypStat
          value={pct(w.baseline.abandonment)}
          label={
            <>
              of other shoppers who reached {page} left ({w.baseline.sessions})
            </>
          }
        />
        <HypStat value={`+${Math.round(w.lift * 100)} pts`} label={chanceText(w.p_value)} />
      </div>
      {d.revenue_lost && <RevenueLost r={d.revenue_lost} prominent at={d.created_at} />}
      {d.dry_run && <p className="m-0 text-[13px] text-muted-foreground">{dryRunLine(d.dry_run)}</p>}

      {open && (
        <div className="flex flex-col gap-3 border-t pt-3">
          <p className="m-0 text-sm">
            <b className="font-semibold">Why I think so:</b> {w.hypothesis}
          </p>
          <p className="m-0 text-[13px] leading-relaxed">
            {probe ? (
              <>
                <Badge className="mr-1 bg-agent-muted text-agent">New probe</Badge>
                <code>{probe.name}</code> reads <code>{probe.selector}</code> on {probe.routes?.join(', ') ?? 'every page'} as {probe.kind === 'money' ? 'money' : 'a number'}. Nobody probed it: the agent found it on the recorded pages. Approving
                registers it.
              </>
            ) : (
              <>
                <Badge variant="outline" className={cn('mr-1', w.feature.source === 'request' && 'border-synthetic-border bg-synthetic-muted text-synthetic')}>
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
        </div>
      )}

      <p className="m-0 text-xs text-muted-foreground">Nothing is flagged until you approve. Approving {probe ? 'registers the probe, ' : ''}runs the rule on live traffic, and re-scans the last 30 days.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy !== null} onClick={onApprove}>
          <CheckIcon data-icon="inline-start" aria-hidden="true" />
          {busy === `approve-${r.rule_id}` ? 'Approving…' : probe ? 'Approve probe and rule' : 'Approve rule'}
        </Button>
        <Button variant="outline" disabled={busy !== null} onClick={() => setDialog('edit')}>
          <PencilIcon data-icon="inline-start" aria-hidden="true" />
          {busy === `redraft-${r.rule_id}` ? 'Drafting again…' : 'Change the rule'}
        </Button>
        <Button variant="outline" disabled={busy !== null} onClick={() => setDialog('reject')}>
          <ThumbsDownIcon data-icon="inline-start" aria-hidden="true" />
          {busy === `reject-${r.rule_id}` ? 'Telling the agent…' : 'Not a problem'}
        </Button>
        <Button variant="ghost" className="ml-auto text-primary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide evidence' : 'Show evidence'}
          {open ? <ChevronUpIcon data-icon="inline-end" aria-hidden="true" /> : <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />}
        </Button>
      </div>
      <ErrorNote error={error} />

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
              disabled={busy !== null || sentence.trim().length < 8}
              onClick={() => {
                setDialog('none');
                onRedraft(sentence);
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
              disabled={busy !== null}
              onClick={() => {
                setDialog('none');
                onReject(note);
              }}
            >
              Discard and tell the agent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * Rules in plain English (Phase 4). A merchant describes what must always hold; Gemini drafts an
 * invariant over the store's probes; a dry run shows what it would flag; approving it runs it on live
 * traffic and re-scans the last 30 days, so shoppers it already hurt show up as found later.
 */
export function RulesPage() {
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [builtin, setBuiltin] = useState<BuiltinRuleView[]>([]);
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const [sentence, setSentence] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  /** The action that failed, so a draft card shows its own error instead of the composer. */
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [watchNote, setWatchNote] = useState<string | null>(null);

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
      await load();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setErrorKey(key);
    } finally {
      setBusy(null);
    }
  };

  const issueFor = (ruleId: string) => clusters.find((c) => c.kind === 'invariant' && c.anchor === ruleId) ?? null;

  const header = (
    <PageHeader
      title="Rules"
      description={
        <>
          Describe something that must always be true in your store, or let the agent find what makes shoppers leave. Gemini turns it into a check over the numbers your sessions report (probes), a dry run shows what it would flag,
          and approving it runs it on live traffic and re-scans the last 30 days. Shoppers it already hurt show up as <Badge className="bg-agent-muted text-agent">found later</Badge>.
        </>
      }
    >
      <SyntheticNote>Synthetic data: demo sessions only</SyntheticNote>
    </PageHeader>
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
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </>
    );
  }

  const drafts = rules.filter((r) => r.draft);
  // Drafts stored before origin existed have none: they are the merchant's.
  const hypotheses = drafts.filter((r) => r.draft!.origin === 'agent' && r.draft!.watch);
  const suggested = drafts.filter((r) => r.draft!.origin === 'agent' && !r.draft!.watch);
  const own = drafts.filter((r) => r.draft!.origin !== 'agent');
  const errorFor = (r: RuleView) => (['approve', 'reject', 'redraft'].some((a) => errorKey === `${a}-${r.rule_id}`) ? error : null);
  const active = rules.filter((r) => r.active);
  const card = (r: RuleView) => (
    <DraftCard
      key={`draft-${r.rule_id}`}
      r={r}
      busy={busy}
      error={errorKey === `approve-${r.rule_id}` || errorKey === `reject-${r.rule_id}` ? error : null}
      onApprove={() => void act(`approve-${r.rule_id}`, () => approveRule(r.rule_id, r.draft!.rule.version))}
      onDiscard={() => void act(`reject-${r.rule_id}`, () => rejectRule(r.rule_id))}
    />
  );

  return (
    <>
      {header}

      <section id="agent-suspects" aria-labelledby="agent-suspects-title" className="flex scroll-mt-20 flex-col gap-3 rounded-2xl border border-dashed border-agent-border bg-agent-muted/40 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <SparklesIcon aria-hidden="true" className="size-5 text-agent" />
          <SectionTitle id="agent-suspects-title">The agent suspects</SectionTitle>
          <span className="text-[13px] text-muted-foreground">It watches every session for numbers shoppers leave over. These are hypotheses: nothing is flagged until you approve.</span>
          <Button variant="outline" size="sm" className="ml-auto" disabled={busy !== null} onClick={() => void act('watch', async () => setWatchNote(watchSummary(await runWatch())))}>
            <ScanSearchIcon data-icon="inline-start" aria-hidden="true" />
            {busy === 'watch' ? 'Looking…' : 'Look now'}
          </Button>
        </div>
        {watchNote && <p className="m-0 text-[13px] text-muted-foreground">{watchNote}</p>}
        {hypotheses.length === 0 && suggested.length === 0 ? (
          <p className="m-0 text-[13px] text-muted-foreground">
            Nothing suspected yet. The agent proposes a probe and a rule when shoppers who meet some number (a fee, a wait, a delivery estimate) leave far more often than everyone else.
          </p>
        ) : (
          <>
            {hypotheses.map((r) => (
              <HypothesisCard
                key={`hyp-${r.rule_id}`}
                r={r}
                busy={busy}
                error={errorFor(r)}
                onApprove={() => void act(`approve-${r.rule_id}`, () => approveRule(r.rule_id, r.draft!.rule.version))}
                onRedraft={(s) => void act(`redraft-${r.rule_id}`, () => redraftRule(r.rule_id, s))}
                onReject={(note) => void act(`reject-${r.rule_id}`, () => rejectRule(r.rule_id, note))}
              />
            ))}
            {suggested.map(card)}
          </>
        )}
      </section>

      <section className="mt-6 flex flex-col gap-3">
        <SectionTitle>Write a rule</SectionTitle>
        <Card className="gap-3 px-5">
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
          <div>
            <Button disabled={busy !== null || sentence.trim().length < 8} onClick={() => void act('draft', () => draftRule(sentence))}>
              {busy === 'draft' ? 'Drafting… (rule author + dry run)' : 'Draft rule'}
            </Button>
          </div>
          {error && !drafts.some((r) => errorKey === `approve-${r.rule_id}` || errorKey === `reject-${r.rule_id}`) && (
            <Alert variant="destructive">
              <AlertTitle>{error instanceof ApiError && error.code === 'not_understood' ? 'The rule author could not express this as a rule.' : 'That did not work.'}</AlertTitle>
              <AlertDescription>
                <span>{error.message}</span>
                {error instanceof ApiError && error.author && <span className="text-xs">{authorLine(error.author)}</span>}
              </AlertDescription>
            </Alert>
          )}
        </Card>
        {own.map(card)}
      </section>

      <ProbesPanel onChanged={() => void load()} />

      <section className="mt-6 flex flex-col gap-3">
        <SectionTitle>Your rules</SectionTitle>
        {active.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground">No approved rules yet. Draft one above.</p>
        ) : (
          active.map((r) => {
            const a = r.active!;
            return (
              <Card key={`active-${r.rule_id}`} className="gap-3 px-5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge className="bg-success-muted text-success">Live · v{a.rule.version}</Badge>
                  <span className="text-xs text-muted-foreground">
                    approved {ago(a.approved_at)} by {a.approved_by}
                    {a.author ? ` · ${a.author.offline ? 'offline stand-in' : a.author.model}` : ''}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto"
                    disabled={busy !== null}
                    onClick={() => void act(`undo-${r.rule_id}`, () => undoRule(r.rule_id))}
                    title="Switch this rule off. What it already found stays as history."
                  >
                    <Undo2Icon data-icon="inline-start" aria-hidden="true" />
                    {busy === `undo-${r.rule_id}` ? 'Switching off…' : 'Undo (switch off)'}
                  </Button>
                </div>
                <h3 className="m-0 text-base font-semibold">{r.title}</h3>
                {sentenceLine(a.sentence)}
                <p className="m-0">
                  <code className="rounded-md border bg-muted px-2 py-1 text-[13px]">{r.text.active}</code>
                </p>
                {r.rescan && <RescanBlock s={r.rescan} issue={issueFor(r.rule_id)} busy={busy !== null} onRescan={() => void act(`rescan-${r.rule_id}`, () => rescanRule(r.rule_id))} />}
              </Card>
            );
          })
        )}
      </section>

      <section className="mt-6 flex flex-col gap-3">
        <SectionTitle>Built-in rules</SectionTitle>
        {builtin.map((b) => (
          <Card key={b.rule_id} className="gap-2 bg-muted/50 px-5">
            <div>
              <Badge variant="secondary">Built-in · v{b.version}</Badge>
            </div>
            <h3 className="m-0 text-base font-semibold">{b.title}</h3>
            <p className="m-0">
              <code className="rounded-md border bg-card px-2 py-1 text-[13px]">{b.text}</code>
            </p>
          </Card>
        ))}
      </section>
      <p className="mt-4 mb-0 text-xs text-muted-foreground">All sessions and numbers are synthetic.</p>
    </>
  );
}
