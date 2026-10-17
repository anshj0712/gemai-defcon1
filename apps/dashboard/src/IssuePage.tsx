import { useEffect, useState } from 'react';
import type { Cluster, Finding } from '@cp/schema';
import { ArrowLeftIcon, CheckCircle2Icon, PlayIcon, RotateCcwIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { fetchCluster, fetchFinding, reopenFinding, resolveFinding, type FindingVersionView } from './api';
import { Fold, KindBadge, SymptomChip } from './components/common';
import { FindingFolds, FindingSummary } from './FindingPanel';
import { ago, isResolved, symptomColor, symptomName, time } from './format';

/**
 * One issue. At a glance: what it costs, what shoppers hit, the proof, and how to recreate it (compact
 * cards that open for detail). Behind that, closed by default: how it was scored, the evidence the
 * agents saw, the symptoms and errors, the occurrences and affected sessions, and the audit trail.
 */
export function IssuePage({ clusterId }: { clusterId: string }) {
  const [cluster, setCluster] = useState<Cluster | null>(null);
  const [finding, setFinding] = useState<{ finding: Finding; versions: FindingVersionView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    <a href="#/" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-ml-2 self-start text-muted-foreground no-underline')}>
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
        <div className="grid gap-4 md:grid-cols-[minmax(280px,340px)_1fr]">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }

  const total = Object.values(cluster.detectors).reduce((a, b) => a + b, 0) || 1;
  const latest = cluster.evidence[0];
  const releases = Object.keys(cluster.releases);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {back}
        {finding &&
          (isResolved(finding.finding) ? (
            <div className="ml-auto flex items-center gap-3 rounded-lg border border-success-border bg-success-muted px-3 py-1.5 text-sm text-success">
              <CheckCircle2Icon aria-hidden="true" className="size-4" />
              Marked fixed {ago(finding.finding.resolution!.resolved_at)}. If shoppers hit it again, it reopens by itself.
              <Button variant="outline" size="xs" disabled={busy} onClick={() => void toggleFixed(true)}>
                <RotateCcwIcon data-icon="inline-start" aria-hidden="true" />
                Reopen
              </Button>
            </div>
          ) : (
            <div className="ml-auto flex items-center gap-3">
              {finding.finding.resolution && <span className="text-xs text-muted-foreground">Seen again after it was marked fixed, so it is open again.</span>}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void toggleFixed(false)}>
                <CheckCircle2Icon data-icon="inline-start" aria-hidden="true" />
                {busy ? 'Saving…' : 'Mark as fixed'}
              </Button>
            </div>
          ))}
      </div>

      {finding ? (
        <FindingSummary finding={finding.finding} cluster={cluster} />
      ) : (
        <div className="flex flex-col items-start gap-2">
          <KindBadge kind={cluster.kind} />
          <h1 className="issue-title m-0 text-2xl font-semibold tracking-tight">{cluster.title}</h1>
          <p className="m-0 text-[13px] text-muted-foreground">
            <code>{cluster.anchor}</code> · {cluster.route} · {cluster.session_count} sessions · last seen {ago(cluster.last_seen)}
          </p>
          <Alert>
            <AlertTitle>Not scored yet</AlertTitle>
            <AlertDescription>
              <span>
                The agent service has not scored this issue yet. It does within a few seconds of the issue opening when <code>pnpm dev</code> is running.
              </span>
            </AlertDescription>
          </Alert>
          {latest && (
            <a className={cn(buttonVariants(), 'no-underline')} href={`#/sessions/${latest.session_id}?signal=${latest.signal_id}`}>
              <PlayIcon data-icon="inline-start" aria-hidden="true" />
              Watch the latest occurrence
            </a>
          )}
        </div>
      )}

      <div className="mt-2 flex flex-col gap-2">
        {finding && <FindingFolds finding={finding.finding} versions={finding.versions} />}
        <Fold title="Symptoms and errors" hint={`${Object.keys(cluster.detectors).length} kinds · ${cluster.signal_count} signals · ${releases.length} release${releases.length === 1 ? '' : 's'}: ${releases.join(', ')}`}>
          <div className="flex flex-col gap-2">
            {Object.entries(cluster.detectors)
              .sort((a, b) => b[1] - a[1])
              .map(([d, n]) => (
                <div key={d} className="grid grid-cols-[160px_1fr_48px] items-center gap-3 text-sm">
                  <span>{symptomName(d)}</span>
                  <span className="h-2.5 overflow-hidden rounded-full bg-muted">
                    <span className="block h-full rounded-full" style={{ width: `${(n / total) * 100}%`, background: symptomColor(d) }} />
                  </span>
                  <b className="text-right tabular-nums">{n}</b>
                </div>
              ))}
          </div>
          {Object.keys(cluster.error_signatures).length > 0 && (
            <>
              <h3 className="m-0 mt-1 text-sm font-semibold">Errors seen just before</h3>
              <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
                {Object.entries(cluster.error_signatures)
                  .sort((a, b) => b[1] - a[1])
                  .map(([sig, n]) => (
                    <li key={sig}>
                      <code>{sig}</code> <span className="text-muted-foreground">× {n}</span>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </Fold>
        <Fold title="Occurrences and affected sessions" hint={`last seen ${ago(cluster.last_seen)} · ${cluster.session_count} sessions`}>
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
          <h3 className="m-0 text-sm font-semibold">All affected sessions ({cluster.session_count})</h3>
          <div className="flex max-h-56 flex-wrap gap-1.5 overflow-auto">
            {cluster.sessions.map((s) => (
              <a key={s} href={`#/sessions/${s}`} className="no-underline">
                <code>{s}</code>
              </a>
            ))}
          </div>
        </Fold>
      </div>
      <p className="m-0 text-xs text-muted-foreground">All sessions and numbers are synthetic.</p>
    </div>
  );
}
