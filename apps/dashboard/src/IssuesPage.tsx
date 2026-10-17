import { useEffect, useRef, useState } from 'react';
import type { FindingSummary } from '@cp/schema';
import { ArrowRightIcon, ChevronRightIcon, FlameIcon, InboxIcon, PlayIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { fetchClusters, fetchFindings, type ClusterSummary } from './api';
import { AnimatedNumber, FoundLaterBadge, NeedsReviewBadge, PageHeader, PendingTierBadge, SymptomChip, TierBadge } from './components/common';
import { ago, isResolved, money, pct, plain, TIER_NAMES } from './format';
import { rankIssues } from './lib/issues';

const REFRESH_MS = 3000;
const ALL = 'all';
const TIERS = ['P0', 'P1', 'P2', 'P3'] as const;

function LiveStatus({ updatedAt }: { updatedAt: number | null }) {
  return (
    <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <span aria-hidden="true" className="live-dot" /> Live · updated {updatedAt ? ago(updatedAt) : '-'}
    </span>
  );
}

/** The one issue to fix first, with what it is costing as the biggest number on the page. */
function FixFirst({ cluster: c, finding: f }: { cluster: ClusterSummary; finding: FindingSummary }) {
  const r = f.revenue;
  const latest = c.evidence[0];
  return (
    <section aria-labelledby="fix-first-title" className="grid gap-5 rounded-2xl border border-danger-border bg-danger-muted p-5 lg:grid-cols-[1fr_auto]">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-money uppercase">
          <FlameIcon aria-hidden="true" className="size-4" />
          Fix this first
        </span>
        <h2 id="fix-first-title" className="m-0 text-xl leading-snug font-semibold">
          {f.title}
        </h2>
        {f.triage && <p className="m-0 line-clamp-2 max-w-3xl text-sm text-foreground/80">{plain(f.triage.summary.text)}</p>}
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          <TierBadge tier={f.tier} />
          <span>{c.route}</span>·<span>{c.session_count} shoppers</span>·<span>last seen {ago(c.last_seen)}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-2">
          <a className={cn(buttonVariants(), 'no-underline')} href={`#/issues/${c.cluster_id}`}>
            Open the issue
            <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
          </a>
          {latest && (
            <a className={cn(buttonVariants({ variant: 'outline' }), 'bg-card no-underline')} href={`#/sessions/${latest.session_id}?signal=${latest.signal_id}`}>
              <PlayIcon data-icon="inline-start" aria-hidden="true" />
              Watch it happen
            </a>
          )}
        </div>
      </div>
      <div className="flex flex-col justify-center gap-1 lg:items-end lg:text-right">
        <span className="text-[13px] font-medium text-money">Revenue lost so far</span>
        <span className="text-5xl leading-none font-bold text-money">
          {r.status === 'ok' ? <AnimatedNumber value={r.revenue_at_risk_minor} format={(n) => money(Math.round(n), r.currency)} ms={900} /> : '…'}
        </span>
        {r.status === 'ok' && (
          <span className="text-[13px] text-muted-foreground">
            {pct(r.abandonment_affected)} of these shoppers left, against {pct(r.abandonment_baseline)} normally
          </span>
        )}
      </div>
    </section>
  );
}

/**
 * The full issue list: the one to fix first, then every open issue as one compact row (priority, problem, page,
 * symptoms, shoppers, money, last seen), filterable by priority and page. Refreshes every 3 s; a row flashes when it
 * gains signals. Detail (selectors, errors, evidence) lives on each issue's page.
 */
export function IssuesPage() {
  const [clusters, setClusters] = useState<ClusterSummary[] | null>(null);
  const [findings, setFindings] = useState<FindingSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [bumped, setBumped] = useState<Set<string>>(new Set());
  const [tier, setTier] = useState<string>(ALL);
  const [page, setPage] = useState<string>(ALL);
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
    const timer = setInterval(load, REFRESH_MS);
    const clock = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
      clearInterval(clock);
    };
  }, []);

  const header = (
    <PageHeader title="Issues" description="Each issue is one broken thing across every shopper it hit, ranked by priority and money.">
      <LiveStatus updatedAt={updatedAt} />
    </PageHeader>
  );

  if (error && !clusters) {
    return (
      <>
        {header}
        <Alert variant="destructive">
          <AlertTitle>Could not load issues</AlertTitle>
          <AlertDescription>
            {error}. Is the API running? Try <code>pnpm dev</code>.
          </AlertDescription>
        </Alert>
      </>
    );
  }
  if (!clusters) {
    return (
      <>
        {header}
        <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading issues">
          <Skeleton className="h-44 rounded-2xl" />
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      </>
    );
  }

  const all = rankIssues(clusters, findings);
  const ranked = all.filter((r) => !isResolved(r.finding));
  const resolved = all.filter((r) => isResolved(r.finding));
  const first = ranked.find((r) => r.finding && r.finding.status === 'open');
  const routes = [...new Set(ranked.map((r) => r.cluster.route))].sort();
  const shown = ranked.filter((r) => (tier === ALL || r.finding?.tier === tier) && (page === ALL || r.cluster.route === page));
  const count = (t: string) => ranked.filter((r) => r.finding?.tier === t).length;

  return (
    <>
      {header}

      {first?.finding && <FixFirst cluster={first.cluster} finding={first.finding} />}

      {clusters.length === 0 ? (
        <Empty className="mt-4 border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No issues yet</EmptyTitle>
            <EmptyDescription>
              Shop at the demo store (Demo shop, top right), or run <code>pnpm sim -- --sessions 50</code> to seed test shoppers.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="mt-6 mb-3 flex flex-wrap items-center gap-3">
            <h2 className="m-0 mr-auto text-lg font-semibold tracking-tight">
              All open issues <span className="font-normal text-muted-foreground tabular-nums">{ranked.length}</span>
            </h2>
            <ToggleGroup type="single" variant="outline" size="sm" value={tier} onValueChange={(v) => setTier(v || ALL)} aria-label="Filter by priority">
              <ToggleGroupItem value={ALL}>All</ToggleGroupItem>
              {TIERS.map((t) => (
                <ToggleGroupItem key={t} value={t} aria-label={`${TIER_NAMES[t]} (${count(t)})`}>
                  {t} <span className="text-muted-foreground tabular-nums">{count(t)}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Select value={page} onValueChange={setPage}>
              <SelectTrigger size="sm" className="w-40" aria-label="Filter by page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={ALL}>All pages</SelectItem>
                  {routes.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
            <div className="hidden grid-cols-[88px_minmax(0,1fr)_200px_84px_120px_120px_20px] gap-4 border-b bg-muted/50 px-4 py-2 text-xs font-medium text-muted-foreground lg:grid">
              <span>Priority</span>
              <span>Problem</span>
              <span>Symptoms</span>
              <span className="text-right">Shoppers</span>
              <span className="text-right">At risk</span>
              <span className="text-right">Last seen</span>
              <span />
            </div>
            {shown.length === 0 && <p className="m-0 px-4 py-6 text-sm text-muted-foreground">No open issues match these filters.</p>}
            {shown.map(({ cluster: c, finding: f }, i) => (
              // The list arrives as a list: a short stagger on first load only (keys are stable, so refreshes do not replay it).
              <div key={c.cluster_id} className="motion-enter border-b last:border-b-0" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
                <a
                  href={`#/issues/${c.cluster_id}`}
                  className={cn(
                    'issue group/issue grid grid-cols-1 items-center gap-2 bg-card px-4 py-3 text-card-foreground no-underline transition-colors duration-200 hover:bg-muted/50 lg:grid-cols-[88px_minmax(0,1fr)_200px_84px_120px_120px_20px] lg:gap-4',
                    bumped.has(c.cluster_id) && 'bump',
                  )}
                >
                  <span>{f ? <TierBadge tier={f.tier} short /> : <PendingTierBadge />}</span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-semibold">{f?.title ?? c.title}</span>
                      {f?.status === 'suspect' && <NeedsReviewBadge />}
                      {c.found_later && c.found_later.sessions > 0 && <FoundLaterBadge>Found later</FoundLaterBadge>}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {c.route}
                      {c.kind === 'invariant' && (
                        <Badge variant="outline" className="ml-2 h-4 border-0 bg-agent-muted px-1.5 text-[10px] text-agent">
                          Data rule
                        </Badge>
                      )}
                    </span>
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {Object.entries(c.detectors)
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 2)
                      .map(([d, n]) => (
                        <SymptomChip key={d} detector={d} count={n} />
                      ))}
                  </span>
                  <span className="font-semibold tabular-nums lg:text-right">
                    <AnimatedNumber value={c.session_count} />
                  </span>
                  <span className="font-semibold text-money tabular-nums lg:text-right">
                    {f ? f.revenue.status === 'ok' ? <AnimatedNumber value={f.revenue.revenue_at_risk_minor} format={(n) => money(Math.round(n), f.revenue.currency)} /> : '…' : '-'}
                  </span>
                  <span className="text-xs text-muted-foreground lg:text-right">{ago(c.last_seen)}</span>
                  <ChevronRightIcon aria-hidden="true" className="hidden size-4 text-muted-foreground transition-transform duration-200 ease-out-expo group-hover/issue:translate-x-0.5 group-hover/issue:text-foreground lg:block" />
                </a>
              </div>
            ))}
          </div>
        </>
      )}

      {resolved.length > 0 && (
        <details className="group mt-4 rounded-xl border bg-card px-4 py-3">
          <summary className="flex cursor-pointer list-none items-baseline gap-2 font-medium [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon aria-hidden="true" className="size-4 translate-y-0.5 text-muted-foreground transition-transform group-open:rotate-90" />
            Resolved · {resolved.length}
            <span className="text-xs font-normal text-muted-foreground">marked fixed and not seen since; one reopens by itself if it comes back</span>
          </summary>
          <div className="motion-reveal mt-2 flex flex-col">
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
