import { useEffect, useState } from 'react';
import type { FindingSummary } from '@cp/schema';
import { PulseIcon, ArrowRightIcon, CaretDownIcon, PlayIcon } from '@phosphor-icons/react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { fetchClusters, fetchFindings, fetchSignals, type ClusterSummary, type SignalRowView } from './api';
import { PageHeader, SymptomChip, TierBadge } from './components/common';
import { ago, time } from './format';
import { groupSignals, type SignalGroup } from './lib/signals';

const DESCRIPTION = 'Every detector hit, grouped under the issue it belongs to. Each opens the replay at its moment. Refreshes every 5 s.';
/** The newest group opens on arrival; the rest stay folded so the page reads as a list of issues. */
const OPEN_FIRST = 1;
/** Rows shown per group before "Show all". */
const ROWS = 8;

function Group({ g, finding, defaultOpen }: { g: SignalGroup; finding: FindingSummary | null; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [all, setAll] = useState(false);
  const rows = all ? g.signals : g.signals.slice(0, ROWS);
  const title = finding?.title ?? g.cluster?.title ?? 'Not in an issue yet';
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('rounded-xl bg-card ring-1 ring-border', !g.cluster && 'bg-muted/40')}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={open ? `Hide signals of ${title}` : `Show signals of ${title}`}>
            <CaretDownIcon aria-hidden="true" className={cn('transition-transform duration-200 ease-out-expo', !open && '-rotate-90')} />
          </Button>
        </CollapsibleTrigger>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            {finding && <TierBadge tier={finding.tier} short />}
            <span className="truncate font-semibold">{title}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {g.cluster && <span>{g.cluster.route} ·</span>}
            {g.detectors.map(([d, n]) => (
              <SymptomChip key={d} detector={d} count={n} />
            ))}
          </div>
        </div>
        <div className="flex flex-col text-right">
          <span className="font-semibold tabular-nums">{g.signals.length}</span>
          <span className="text-xs text-muted-foreground">signal{g.signals.length === 1 ? '' : 's'} · {ago(g.lastSeen)}</span>
        </div>
        {g.cluster && (
          <a href={`#/issues/${g.cluster.cluster_id}`} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'no-underline')}>
            Open the issue
            <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
          </a>
        )}
      </div>
      <CollapsibleContent>
        <div className="motion-reveal border-t px-2 pb-2">
          <Table className="signals">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Time</TableHead>
                <TableHead>Symptom</TableHead>
                <TableHead>Element</TableHead>
                <TableHead>Session</TableHead>
                <TableHead>Release</TableHead>
                <TableHead className="pr-3 text-right">Replay</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => (
                <TableRow key={s.signal_id}>
                  <TableCell className="pl-3 tabular-nums">{time(s.event_time)}</TableCell>
                  <TableCell title={s.detector}>
                    <SymptomChip detector={s.detector} />
                  </TableCell>
                  <TableCell>
                    <code>{s.element_selector ?? '-'}</code>
                  </TableCell>
                  <TableCell>
                    <code>{s.session_id.slice(0, 14)}…</code>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{s.release}</TableCell>
                  <TableCell className="pr-3 text-right">
                    <a className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'no-underline')} href={`#/sessions/${s.session_id}?signal=${s.signal_id}`}>
                      <PlayIcon data-icon="inline-start" aria-hidden="true" />
                      Watch replay
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {g.signals.length > ROWS && (
            <Button variant="ghost" size="sm" className="mt-1 ml-1 text-link" onClick={() => setAll(!all)}>
              {all ? `Show the newest ${ROWS}` : `Show all ${g.signals.length} signals`}
            </Button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The newest signals, grouped under the issue that clustered them; signals no issue has taken yet come last. */
export function SignalsPage() {
  const [signals, setSignals] = useState<SignalRowView[] | null>(null);
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const [findings, setFindings] = useState<FindingSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all([fetchSignals(), fetchClusters().catch(() => ({ clusters: [] as ClusterSummary[] })), fetchFindings().catch(() => ({ findings: [] as FindingSummary[] }))]).then(
        ([s, c, f]) => alive && (setSignals(s.signals), setClusters(c.clusters), setFindings(f.findings), setError(null)),
        (e: Error) => alive && setError(e.message),
      );
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (error) {
    return (
      <>
        <PageHeader title="Signals" description={DESCRIPTION} />
        <Alert variant="destructive">
          <AlertTitle>Could not load signals</AlertTitle>
          <AlertDescription>
            {error}. Is the API running? Try <code>pnpm dev</code>.
          </AlertDescription>
        </Alert>
      </>
    );
  }
  if (!signals) {
    return (
      <>
        <PageHeader title="Signals" description={DESCRIPTION} />
        <Skeleton className="h-96 rounded-xl" aria-busy="true" aria-label="Loading signals" />
      </>
    );
  }
  if (signals.length === 0) {
    return (
      <>
        <PageHeader title="Signals" description={DESCRIPTION} />
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PulseIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No signals yet</EmptyTitle>
            <EmptyDescription>Open the demo shop (top right), add something to the bag, and use it like a shopper; signals appear here within seconds.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const groups = groupSignals(signals, clusters);
  const findingOf = new Map(findings.map((f) => [f.cluster_id, f]));
  return (
    <>
      <PageHeader title="Signals" description={DESCRIPTION}>
        <span className="text-[13px] text-muted-foreground tabular-nums">
          {signals.length} newest signals in {groups.filter((g) => g.cluster).length} issue{groups.filter((g) => g.cluster).length === 1 ? '' : 's'}
        </span>
      </PageHeader>
      <div className="flex flex-col gap-2">
        {groups.map((g, i) => (
          <Group key={g.cluster?.cluster_id ?? 'none'} g={g} finding={g.cluster ? (findingOf.get(g.cluster.cluster_id) ?? null) : null} defaultOpen={i < OPEN_FIRST} />
        ))}
      </div>
    </>
  );
}
