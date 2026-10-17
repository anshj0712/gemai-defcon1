import { useEffect, useRef, useState } from 'react';
import type { FindingSummary } from '@cp/schema';
import { ArrowRightIcon, ChevronRightIcon, FlameIcon, InboxIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { fetchClusters, fetchFindings, fetchQuality, type ClusterSummary, type QualityReport } from './api';
import { AnimatedNumber, Eyebrow, FoundLaterBadge, KindBadge, NeedsReviewBadge, PageHeader, PendingTierBadge, Stat, SymptomChip, TierBadge } from './components/common';
import { ago, isResolved, money, TIER_NAMES } from './format';
import { rankIssues } from './lib/issues';

const REFRESH_MS = 3000;

function LiveStatus({ updatedAt }: { updatedAt: number | null }) {
  return (
    <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <span aria-hidden="true" className="live-dot" /> Live · updated {updatedAt ? ago(updatedAt) : '-'}
    </span>
  );
}

function FeedSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading issues">
      <div className="grid grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[74px] rounded-xl" />
        ))}
      </div>
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-[112px] rounded-xl" />
      ))}
    </div>
  );
}

/**
 * The live feed: one card per issue (one broken thing across every affected session), ranked by the
 * agent's findings (tier, then revenue at risk), with issues not yet scored at the end. Refreshes
 * every 3 s; a card flashes when it gains signals.
 */
export function IssuesPage() {
  const [clusters, setClusters] = useState<ClusterSummary[] | null>(null);
  const [findings, setFindings] = useState<FindingSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [quality, setQuality] = useState<QualityReport | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [bumped, setBumped] = useState<Set<string>>(new Set());
  const [, setTick] = useState(0);
  const lastCounts = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all([fetchClusters(), fetchFindings().catch(() => ({ findings: [] as FindingSummary[] }))]).then(
        ([r, f]) => {
          if (!alive) return;
          const changed = new Set<string>();
          for (const c of r.clusters) {
            const prev = lastCounts.current.get(c.cluster_id);
            if (prev !== undefined && prev !== c.signal_count) changed.add(c.cluster_id);
            lastCounts.current.set(c.cluster_id, c.signal_count);
          }
          setClusters(r.clusters);
          setFindings(f.findings);
          setBumped(changed);
          setUpdatedAt(Date.now());
          setError(null);
        },
        (e: Error) => alive && setError(e.message),
      );
    void load();
    void fetchQuality().then((q) => alive && setQuality(q));
    const timer = setInterval(load, REFRESH_MS);
    const clock = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
      clearInterval(clock);
    };
  }, []);

  if (error && !clusters) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load issues</AlertTitle>
        <AlertDescription>
          {error}. Is the API running? Try <code>pnpm dev</code>.
        </AlertDescription>
      </Alert>
    );
  }
  if (!clusters) {
    return (
      <>
        <PageHeader title="Issues" description="Ranked by revenue at risk. Each issue is one broken thing across every shopper it hit." />
        <FeedSkeleton />
      </>
    );
  }

  const all = rankIssues(clusters, findings);
  const ranked = all.filter((r) => !isResolved(r.finding));
  const resolved = all.filter((r) => isResolved(r.finding));
  const open = ranked.map((r) => r.cluster);
  const sessions = open.reduce((n, c) => n + c.session_count, 0);
  const signals = open.reduce((n, c) => n + c.signal_count, 0);
  const estimated = ranked.flatMap((r) => (r.finding && r.finding.revenue.status === 'ok' && r.finding.revenue.currency ? [r.finding] : []));
  // The one to fix first: the best-ranked open issue the agent has scored and found worth acting on.
  const first = ranked.find((r) => r.finding && r.finding.status === 'open');
  const currency = estimated[0]?.revenue.currency ?? null;
  const atRisk = estimated.filter((f) => f.revenue.currency === currency).reduce((n, f) => n + f.revenue.revenue_at_risk_minor, 0);

  return (
    <>
      <PageHeader title="Issues" description="Ranked by revenue at risk. Each issue is one broken thing across every shopper it hit.">
        <LiveStatus updatedAt={updatedAt} />
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat value={<AnimatedNumber value={open.length} />} label="open issues" />
        <Stat value={<AnimatedNumber value={sessions} />} label="affected sessions" />
        <Stat value={<AnimatedNumber value={signals} />} label="signals grouped" />
        <Stat value={estimated.length ? <AnimatedNumber value={atRisk} format={(n) => money(Math.round(n), currency)} ms={900} /> : '-'} tone="money" label="revenue at risk" />
      </div>

      {first?.finding && (
        <a
          href={`#/issues/${first.cluster.cluster_id}`}
          className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-danger-border bg-danger-muted px-4 py-3 text-foreground no-underline transition-colors hover:border-destructive"
        >
          <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-money uppercase">
            <FlameIcon aria-hidden="true" className="size-4" />
            Fix this first
          </span>
          <span className="font-semibold">{first.finding.title}</span>
          <span className="text-[13px] text-muted-foreground">
            {first.finding.revenue.status === 'ok' ? `${money(first.finding.revenue.revenue_at_risk_minor, first.finding.revenue.currency)} lost · ` : ''}
            {TIER_NAMES[first.finding.tier] ?? first.finding.tier} · {first.cluster.session_count} sessions · {first.cluster.route}
          </span>
          <span className="ml-auto flex items-center gap-1 text-sm font-semibold text-money">
            Open <ArrowRightIcon aria-hidden="true" className="size-4" />
          </span>
        </a>
      )}

      {clusters.length === 0 ? (
        <Empty className="mt-4 border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No issues yet</EmptyTitle>
            <EmptyDescription>
              Switch a bug on (top right of the bar above), then shop at <a href="http://localhost:5173/?bugs=dead_button">localhost:5173/?bugs=dead_button</a> and press Apply Coupon 4+ times, or run{' '}
              <code>pnpm sim -- --sessions 50</code> to seed test shoppers.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="mt-4 flex flex-col gap-2.5">
          {ranked.map(({ cluster: c, finding: f }, i) => (
            // The list arrives as a list: a short stagger on first load only (keys are stable, so refreshes do not replay it).
            <div key={c.cluster_id} className="motion-enter" style={{ animationDelay: `${Math.min(i, 8) * 35}ms` }}>
            <a
              href={`#/issues/${c.cluster_id}`}
              className={cn(
                'issue group/issue grid grid-cols-1 items-center gap-4 rounded-xl border bg-card px-5 py-4 text-card-foreground no-underline shadow-xs transition-[border-color,box-shadow,translate] duration-200 ease-out-expo hover:border-input hover:shadow-md motion-safe:hover:-translate-y-px lg:grid-cols-[1fr_auto] lg:gap-8',
                bumped.has(c.cluster_id) && 'bump',
              )}
            >
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  {f ? <TierBadge tier={f.tier} /> : <PendingTierBadge />}
                  <KindBadge kind={c.kind} />
                  {f?.status === 'suspect' && <NeedsReviewBadge />}
                  {c.found_later && c.found_later.sessions > 0 && (
                    <FoundLaterBadge title="A re-scan with a newer rule found shoppers this hurt before the rule existed">
                      Found later · {c.found_later.sessions} session{c.found_later.sessions === 1 ? '' : 's'}
                    </FoundLaterBadge>
                  )}
                </div>
                <div className="flex flex-col gap-0.5">
                  <h3 className="m-0 text-base leading-snug font-semibold">{f?.title ?? c.title}</h3>
                  {f && f.title !== c.title && <p className="m-0 truncate text-xs text-muted-foreground">{c.title}</p>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(c.detectors)
                    .sort((a, b) => b[1] - a[1])
                    .map(([d, n]) => (
                      <SymptomChip key={d} detector={d} count={n} />
                    ))}
                </div>
                {Object.keys(c.error_signatures).length > 0 && (
                  <p className="m-0 truncate font-mono text-xs text-muted-foreground">
                    {Object.entries(c.error_signatures)
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 2)
                      .map(([sig]) => sig)
                      .join(' · ')}
                  </p>
                )}
              </div>
              <dl className="m-0 grid grid-cols-[minmax(96px,auto)_auto_auto_minmax(150px,auto)] items-center gap-x-6 text-right">
                <div className="flex flex-col">
                  <dd className="m-0 text-lg font-semibold text-money tabular-nums">{f ? (f.revenue.status === 'ok' ? <AnimatedNumber value={f.revenue.revenue_at_risk_minor} format={(n) => money(Math.round(n), f.revenue.currency)} /> : '…') : '-'}</dd>
                  <dt className="text-xs text-muted-foreground">at risk</dt>
                </div>
                <div className="flex flex-col">
                  <dd className="m-0 text-lg font-semibold tabular-nums"><AnimatedNumber value={c.session_count} /></dd>
                  <dt className="text-xs text-muted-foreground">sessions</dt>
                </div>
                <div className="flex flex-col">
                  <dd className="m-0 text-lg font-semibold tabular-nums"><AnimatedNumber value={c.signal_count} /></dd>
                  <dt className="text-xs text-muted-foreground">signals</dt>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <div className="flex flex-col text-xs text-muted-foreground">
                    <span>last seen {ago(c.last_seen)}</span>
                    <span className="font-mono">{c.route}</span>
                  </div>
                  <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground transition-transform duration-200 ease-out-expo group-hover/issue:translate-x-0.5 group-hover/issue:text-foreground" />
                </div>
              </dl>
            </a>
            </div>
          ))}
        </div>
      )}

      <QualityCard q={quality} />

      {resolved.length > 0 && (
        <details className="group mt-4 rounded-xl border bg-card px-4 py-3">
          <summary className="flex cursor-pointer list-none items-baseline gap-2 font-medium [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon aria-hidden="true" className="size-4 translate-y-0.5 text-muted-foreground transition-transform group-open:rotate-90" />
            Resolved · {resolved.length}
            <span className="text-xs font-normal text-muted-foreground">marked fixed and not seen since; one reopens by itself if it comes back</span>
          </summary>
          <div className="mt-2 flex flex-col">
            {resolved.map(({ cluster: c, finding: f }) => (
              <a key={c.cluster_id} href={`#/issues/${c.cluster_id}`} className="flex items-center gap-2 border-b py-2 text-sm text-muted-foreground no-underline last:border-b-0 hover:text-foreground">
                <Badge className="bg-success-muted text-success">Fixed {f?.resolution ? ago(f.resolution.resolved_at) : ''}</Badge>
                <span className="text-foreground">{f?.title ?? c.title}</span>
                <span className="text-xs">· {c.session_count} sessions</span>
              </a>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

/** How well the system did on a test with known answers. Synthetic shoppers, so we know which ones hit which bug. */
function QualityCard({ q }: { q: QualityReport | null }) {
  if (!q) {
    return (
      <Card size="sm" className="mt-4 px-4">
        <Eyebrow>Quality: how accurate is this?</Eyebrow>
        <p className="m-0 text-sm text-muted-foreground">
          Not measured yet. Run <code>pnpm sim -- --sessions 240</code>, then <code>pnpm sim:check</code>: it plays test shoppers who hit known bugs and checks what the system found.
        </p>
      </Card>
    );
  }
  const p = (x: number) => `${Math.round(x * 100)}%`;
  const cells: [string, string][] = [
    [`${q.bugs_found}/${q.bugs_expected}`, 'bugs found, each as one issue'],
    [p(q.lowest_recall), 'of shoppers caught (worst bug)'],
    [String(q.clean_sessions_flagged), 'healthy shoppers wrongly flagged'],
    [`${q.jury.approved}/${q.jury.reviewed}`, 'AI reports the jury approved'],
  ];
  return (
    <Card size="sm" className="mt-4 gap-3 px-4">
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow>Quality</Eyebrow>
        <span className="font-medium">
          Found {q.bugs_found} of {q.bugs_expected} planted bugs, {q.false_alarms} false alarm{q.false_alarms === 1 ? '' : 's'}
        </span>
        <Badge className={q.pass ? 'bg-success-muted text-success' : 'bg-danger-muted text-money'}>{q.pass ? 'Test passed' : 'Test failed'}</Badge>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cells.map(([v, l]) => (
          <div key={l} className="flex flex-col">
            <span className="text-xl font-semibold tabular-nums">{v}</span>
            <span className="text-xs text-muted-foreground">{l}</span>
          </div>
        ))}
      </div>
      <p className="m-0 text-xs text-muted-foreground">
        Measured {ago(q.checked_at)} on {q.sessions} test shoppers with planted bugs (seed {q.seed}). We know which shopper hit which bug, so this is a real score.
      </p>
    </Card>
  );
}
