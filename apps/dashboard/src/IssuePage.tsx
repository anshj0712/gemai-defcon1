import { useEffect, useState } from 'react';
import type { Cluster, Finding } from '@cp/schema';
import { ArrowLeftIcon, CheckCircle2Icon, PlayIcon, RotateCcwIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { fetchCluster, fetchFinding, reopenFinding, resolveFinding, type FindingVersionView } from './api';
import { KindBadge, SymptomChip } from './components/common';
import { FindingHeader, FindingProofTab, FindingSummaryTab, FindingTechnicalTab, latestReplayHref } from './FindingPanel';
import { ago, isResolved, symptomColor, symptomName, time } from './format';

type IssueTab = 'summary' | 'proof' | 'sessions' | 'technical';

/** Sessions tab: what shoppers ran into (symptoms, errors), each occurrence to watch, and every affected session. */
function SessionsTab({ cluster }: { cluster: Cluster }) {
  const total = Object.values(cluster.detectors).reduce((a, b) => a + b, 0) || 1;
  const releases = Object.keys(cluster.releases);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold">Symptoms</h3>
          {Object.entries(cluster.detectors)
            .sort((a, b) => b[1] - a[1])
            .map(([d, n]) => (
              <div key={d} className="grid grid-cols-[160px_1fr_48px] items-center gap-3 text-sm">
                <span>{symptomName(d)}</span>
                <span className="h-2.5 overflow-hidden rounded-full bg-muted">
                  <span className="motion-grow block h-full rounded-full" style={{ width: `${(n / total) * 100}%`, background: symptomColor(d) }} />
                </span>
                <b className="text-right tabular-nums">{n}</b>
              </div>
            ))}
          <p className="m-0 text-xs text-muted-foreground">
            {cluster.signal_count} signals on <code>{cluster.anchor}</code> · release{releases.length === 1 ? '' : 's'} {releases.join(', ')}
          </p>
        </section>
        {Object.keys(cluster.error_signatures).length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="m-0 text-sm font-semibold">Errors seen just before</h3>
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm">
              {Object.entries(cluster.error_signatures)
                .sort((a, b) => b[1] - a[1])
                .map(([sig, n]) => (
                  <li key={sig}>
                    <code>{sig}</code> <span className="text-muted-foreground">× {n}</span>
                  </li>
                ))}
            </ul>
          </section>
        )}
      </div>
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold">Latest occurrences</h3>
          <Table>
            <TableBody>
              {cluster.evidence.map((e) => (
                <TableRow key={e.signal_id}>
                  <TableCell className="tabular-nums">{time(e.event_time)}</TableCell>
                  <TableCell>
                    <SymptomChip detector={e.detector} />
                  </TableCell>
                  <TableCell>
                    <code>{e.session_id.slice(0, 14)}…</code>
                  </TableCell>
                  <TableCell className="text-right">
                    <a className={cn(buttonVariants({ variant: 'outline', size: 'xs' }), 'no-underline')} href={`#/sessions/${e.session_id}?signal=${e.signal_id}`}>
                      <PlayIcon data-icon="inline-start" aria-hidden="true" />
                      Watch replay
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-semibold">All affected sessions ({cluster.session_count})</h3>
          <div className="flex max-h-56 flex-wrap gap-1.5 overflow-auto">
            {cluster.sessions.map((s) => (
              <a key={s} href={`#/sessions/${s}`} className="no-underline">
                <code>{s}</code>
              </a>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * One issue. The header (title, priority, page) and the two actions (watch it, mark it fixed) stay on top; the detail
 * is split into tabs so each reads on its own: Summary (cost, what happened, why, how to reproduce), Proof, Sessions,
 * and Technical (the AI review, scoring, evidence, audit trail).
 */
export function IssuePage({ clusterId }: { clusterId: string }) {
  const [cluster, setCluster] = useState<Cluster | null>(null);
  const [finding, setFinding] = useState<{ finding: Finding; versions: FindingVersionView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<IssueTab>('summary');

  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all([fetchCluster(clusterId), fetchFinding(clusterId)]).then(
        ([c, f]) => alive && (setCluster(c.cluster), setFinding(f), setError(null)),
        (e: Error) => alive && setError(e.message),
      );
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [clusterId]);

  const refresh = async () => {
    const [c, f] = await Promise.all([fetchCluster(clusterId), fetchFinding(clusterId)]);
    setCluster(c.cluster);
    setFinding(f);
  };
  const toggleFixed = async (fixed: boolean) => {
    setBusy(true);
    try {
      await (fixed ? reopenFinding(clusterId) : resolveFinding(clusterId));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const back = (
    <a href="#/issues" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-ml-2 self-start text-muted-foreground no-underline')}>
      <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
      Issues
    </a>
  );

  if (error && !cluster) {
    return (
      <div className="flex flex-col gap-3">
        {back}
        <Alert variant="destructive">
          <AlertTitle>Could not load this issue</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!cluster) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading issue">
        {back}
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const replayHref = latestReplayHref(cluster);
  const f = finding?.finding ?? null;
  const resolved = f !== null && isResolved(f);

  return (
    <div className="flex flex-col gap-4">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-4">
        {f ? (
          <FindingHeader finding={f} cluster={cluster} />
        ) : (
          <div className="flex flex-col items-start gap-2">
            <KindBadge kind={cluster.kind} />
            <h1 className="issue-title m-0 text-2xl font-semibold tracking-tight">{cluster.title}</h1>
            <p className="m-0 text-[13px] text-muted-foreground">
              On {cluster.route} · {cluster.session_count} shoppers · last seen {ago(cluster.last_seen)}
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {replayHref && (
            <a className={cn(buttonVariants(), 'no-underline')} href={replayHref}>
              <PlayIcon data-icon="inline-start" aria-hidden="true" />
              Watch the latest occurrence
            </a>
          )}
          {f &&
            (resolved ? (
              <Button variant="outline" disabled={busy} onClick={() => void toggleFixed(true)}>
                <RotateCcwIcon data-icon="inline-start" aria-hidden="true" />
                Reopen
              </Button>
            ) : (
              <Button variant="outline" disabled={busy} onClick={() => void toggleFixed(false)}>
                <CheckCircle2Icon data-icon="inline-start" aria-hidden="true" />
                {busy ? 'Saving…' : 'Mark as fixed'}
              </Button>
            ))}
        </div>
      </div>

      {resolved && (
        <div className="flex items-center gap-2 rounded-lg border border-success-border bg-success-muted px-3 py-2 text-sm text-success">
          <CheckCircle2Icon aria-hidden="true" className="size-4" />
          Marked fixed {ago(f.resolution!.resolved_at)}. If shoppers hit it again, it reopens by itself.
        </div>
      )}
      {f && !resolved && f.resolution && <p className="m-0 text-xs text-muted-foreground">Seen again after it was marked fixed, so it is open again.</p>}

      {f && finding ? (
        <Tabs value={tab} onValueChange={(v) => setTab(v as IssueTab)}>
          <TabsList>
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="proof">Proof</TabsTrigger>
            <TabsTrigger value="sessions">
              Sessions <span className="text-muted-foreground tabular-nums">{cluster.session_count}</span>
            </TabsTrigger>
            <TabsTrigger value="technical">Technical</TabsTrigger>
          </TabsList>
          <TabsContent value="summary" className="motion-reveal pt-4">
            <FindingSummaryTab finding={f} onOpenReview={() => setTab('technical')} />
          </TabsContent>
          <TabsContent value="proof" className="motion-reveal pt-4">
            <FindingProofTab finding={f} cluster={cluster} />
          </TabsContent>
          <TabsContent value="sessions" className="motion-reveal pt-4">
            <SessionsTab cluster={cluster} />
          </TabsContent>
          <TabsContent value="technical" className="motion-reveal pt-4">
            <FindingTechnicalTab finding={f} versions={finding.versions} />
          </TabsContent>
        </Tabs>
      ) : (
        <>
          <Alert>
            <AlertTitle>Not scored yet</AlertTitle>
            <AlertDescription>
              <span>
                The agent service has not scored this issue yet. It does within a few seconds of the issue opening when <code>pnpm dev</code> is running.
              </span>
            </AlertDescription>
          </Alert>
          <SessionsTab cluster={cluster} />
        </>
      )}
    </div>
  );
}
