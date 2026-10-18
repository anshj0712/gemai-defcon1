import { useEffect, useMemo, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { fetchHistory, type HistoryFindingView, type HistoryView } from './api';
import { FoundLaterBadge, PageHeader, Stat, TierBadge } from './components/common';
import { money } from './format';
import { defaultAsOf, totalAtRisk } from './lib/history';
import { RevenueTimeline, RuleImpact } from './RevenueTimeline';

const WINDOWS = [
  { label: '24 hours', ms: 86_400_000 },
  { label: '7 days', ms: 7 * 86_400_000 },
  { label: '30 days', ms: 30 * 86_400_000 },
] as const;

const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

const DESCRIPTION =
  'What did we know at a moment in the past, compared with what we know now about the same stretch of shopper activity? Issues that appear only today were already hurting shoppers; the rules at the time did not flag them.';

function Row({ f, foundLater }: { f: HistoryFindingView; foundLater: boolean }) {
  return (
    <a
      href={`#/issues/${f.finding_id}`}
      className={cn('grid grid-cols-[auto_1fr_auto] items-start gap-3 rounded-lg border-t px-2 py-2.5 text-foreground no-underline transition-colors first:border-t-0 hover:bg-muted/60', foundLater && 'border-t-transparent bg-agent-muted hover:bg-agent-muted')}
    >
      <TierBadge tier={f.tier} short className="mt-0.5" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5 font-medium">
          {f.title}
          {foundLater && <FoundLaterBadge>Found later</FoundLaterBadge>}
        </span>
        <span className="text-xs text-muted-foreground">
          {f.affected_sessions} sessions{f.found_later_sessions ? `, ${f.found_later_sessions} found by re-scan` : ''} · first hit {when(f.valid_from)} · recorded {when(f.recorded_from)}
        </span>
      </span>
      <b className="font-semibold whitespace-nowrap text-money tabular-nums">{f.revenue_status === 'ok' ? money(f.revenue_at_risk_minor, f.currency) : '…'}</b>
    </a>
  );
}

/**
 * Time travel (bitemporal): pick a moment T and a stretch of shopper activity before it. The left
 * column is what the findings record said at T; the right is what it says now about the same stretch.
 * Issues only on the right are found later: shoppers were already hurt, but the rules at T missed it.
 */
export function HistoryPage() {
  const [now] = useState(() => Date.now());
  const [asOf, setAsOf] = useState<number | null>(null);
  const [windowMs, setWindowMs] = useState<number>(WINDOWS[1].ms);
  const [data, setData] = useState<HistoryView | null>(null);
  const [minT, setMinT] = useState<number>(now - 86_400_000);
  const [error, setError] = useState<string | null>(null);

  // First load: find the moments and the earliest activity, then start just before the latest approval.
  useEffect(() => {
    fetchHistory(now, now - 30 * 86_400_000, now).then(
      (h) => {
        // Start a minute before the first shopper hit anything, so recent activity spans the whole slider.
        const earliest = h.current.length ? Math.min(...h.current.map((f) => f.valid_from)) - 60_000 : now - 3_600_000;
        setMinT(earliest);
        setAsOf(Math.max(earliest, defaultAsOf(h.moments, now)));
      },
      (e: Error) => setError(e.message),
    );
  }, [now]);

  useEffect(() => {
    if (asOf === null) return;
    let alive = true;
    const t = setTimeout(() => {
      fetchHistory(asOf, asOf - windowMs, asOf).then(
        (h) => alive && (setData(h), setError(null)),
        (e: Error) => alive && setError(e.message),
      );
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [asOf, windowMs]);

  const later = useMemo(() => new Set(data?.found_later ?? []), [data]);
  const header = (
    <PageHeader title="Time travel" description={DESCRIPTION} />
  );
  if (error && !data) {
    return (
      <>
        {header}
        <Alert variant="destructive">
          <AlertTitle>Could not load the history</AlertTitle>
          <AlertDescription>
            {error}. Is the API running? Try <code>pnpm dev</code>.
          </AlertDescription>
        </Alert>
      </>
    );
  }
  if (asOf === null || !data) {
    return (
      <>
        {header}
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading the history">
          <Skeleton className="h-36 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </>
    );
  }

  const then = totalAtRisk(data.then);
  const current = totalAtRisk(data.current);
  const laterList = data.current.filter((f) => later.has(f.finding_id));
  const laterMoney = totalAtRisk(laterList);
  const span = Math.max(1, now - minT);

  return (
    <>
      {header}

      <div className="mb-4 flex flex-col gap-4">
        <RevenueTimeline asOf={asOf} onPick={(t) => setAsOf(Math.max(minT, Math.min(now, t)))} />
        <RuleImpact />
      </div>

      <Card className="gap-3 px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm">
            As of <b className="font-semibold tabular-nums">{when(asOf)}</b>
          </span>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            shopper activity in the
            <Select value={String(windowMs)} onValueChange={(v) => setWindowMs(Number(v))}>
              <SelectTrigger size="sm" className="w-28" aria-label="Stretch of shopper activity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {WINDOWS.map((w) => (
                    <SelectItem key={w.ms} value={String(w.ms)}>
                      {w.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            before it
          </label>
        </div>
        <div className="relative pt-1 pb-4">
          <input type="range" className="w-full accent-agent-strong" min={minT} max={now} step={1000} value={asOf} onChange={(e) => setAsOf(Number(e.target.value))} aria-label="As of" aria-valuetext={when(asOf)} />
          {data.moments.map((m) => (
            <span
              key={`${m.kind}-${m.at}`}
              className={cn('absolute bottom-0.5 -ml-px h-3 w-[3px] rounded-sm', m.kind === 'rescan_done' ? 'bg-success-strong' : 'bg-agent-strong')}
              style={{ left: `${((m.at - minT) / span) * 100}%` }}
              title={`${m.label} · ${when(m.at)}`}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {data.moments.map((m) => (
            <Button key={`jump-${m.kind}-${m.at}`} variant="outline" size="xs" onClick={() => setAsOf(m.kind === 'rule_approved' ? m.at - 1000 : m.at + 1000)}>
              {m.kind === 'rule_approved' ? 'Just before: ' : 'Just after: '}
              {m.label}
            </Button>
          ))}
          <Button variant="outline" size="xs" onClick={() => setAsOf(now)}>
            Now
          </Button>
        </div>
      </Card>

      <div className="my-4 grid gap-3 md:grid-cols-3">
        <Stat value={data.then.length} label={`issues known at ${when(asOf)} · ${money(then.minor, then.currency)} at risk`} />
        <Stat value={data.current.length} label={`issues known now, same stretch · ${money(current.minor, current.currency)} at risk`} />
        <Stat
          value={laterList.length}
          tone={laterList.length ? 'agent' : undefined}
          className={cn(laterList.length > 0 && 'bg-agent-muted ring-agent-border')}
          label={
            <>
              found later · {money(laterMoney.minor, laterMoney.currency)} at risk
            </>
          }
        />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card className="gap-2 px-4">
          <h3 className="m-0 px-2 text-sm font-semibold">What we knew then</h3>
          {data.then.length === 0 ? <p className="m-0 px-2 text-sm text-muted-foreground">No issues were on record at that moment for this stretch.</p> : data.then.map((f) => <Row key={f.finding_id} f={f} foundLater={false} />)}
        </Card>
        <Card className="gap-2 px-4">
          <h3 className="m-0 px-2 text-sm font-semibold">What we know now about the same stretch</h3>
          {data.current.length === 0 ? <p className="m-0 px-2 text-sm text-muted-foreground">No issues on record for this stretch.</p> : data.current.map((f) => <Row key={f.finding_id} f={f} foundLater={later.has(f.finding_id)} />)}
        </Card>
      </div>
      <p className="mt-4 mb-0 text-xs text-muted-foreground">Both columns come from the versioned findings record (valid time and transaction time), not the live feed.</p>
    </>
  );
}
