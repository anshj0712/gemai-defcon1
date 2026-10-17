import { useEffect, useState, type ReactNode } from 'react';
import type { FindingSummary } from '@cp/schema';
import { ArrowRightIcon, HistoryIcon, ScrollTextIcon, SparklesIcon, UsersIcon } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, LabelList, ReferenceLine, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { fetchClusters, fetchFindings, fetchQuality, fetchRules, type ClusterSummary, type QualityReport, type RuleView } from './api';
import { AnimatedNumber, Eyebrow, PageHeader, TierBadge } from './components/common';
import { ago, isResolved, money, moneyCompact, TIER_NAMES } from './format';
import { rankIssues } from './lib/issues';
import { useRevenueSeries } from './lib/useRevenueSeries';

const REFRESH_MS = 5000;
const TIERS = ['P0', 'P1', 'P2', 'P3'] as const;
const TIER_FILL: Record<string, string> = { P0: 'bg-tier-p0', P1: 'bg-tier-p1', P2: 'bg-tier-p2', P3: 'bg-tier-p3' };

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** One series (revenue at risk), so no legend box: the card title names it. Color follows the app's money token. */
const revenueConfig = { total: { label: 'Revenue at risk', color: 'var(--money)' } } satisfies ChartConfig;
const pageConfig = { revenue: { label: 'Revenue at risk', color: 'var(--money)' } } satisfies ChartConfig;

/** A KPI card that leads somewhere. */
function LinkStat({ href, icon: Icon, label, value, children }: { href: string; icon: typeof UsersIcon; label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <a href={href} className="group/stat flex flex-col gap-1 rounded-xl border bg-card px-4 py-3 text-card-foreground no-underline shadow-xs transition-[border-color,box-shadow,translate] duration-200 ease-out-expo hover:border-input hover:shadow-md motion-safe:hover:-translate-y-px">
      <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <Icon aria-hidden="true" className="size-4" />
        {label}
        <ArrowRightIcon aria-hidden="true" className="ml-auto size-3.5 opacity-0 transition-opacity duration-200 group-hover/stat:opacity-100" />
      </span>
      <span className="text-2xl leading-tight font-semibold tabular-nums">{value}</span>
      {children}
    </a>
  );
}

/**
 * The merchant's first glance: what the store is losing now, how that moved over time, what to fix first, where it
 * hurts, and what the agent is waiting on. Every block links to the page with the detail.
 */
export function DashboardPage() {
  const [clusters, setClusters] = useState<ClusterSummary[] | null>(null);
  const [findings, setFindings] = useState<FindingSummary[]>([]);
  const [rules, setRules] = useState<RuleView[]>([]);
  const [quality, setQuality] = useState<QualityReport | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const series = useRevenueSeries();

  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all([fetchClusters(), fetchFindings().catch(() => ({ findings: [] as FindingSummary[] })), fetchRules().catch(() => ({ rules: [] as RuleView[] }))]).then(
        ([c, f, r]) => {
          if (!alive) return;
          setClusters(c.clusters);
          setFindings(f.findings);
          setRules(r.rules);
          setUpdatedAt(Date.now());
        },
        () => undefined,
      );
    void load();
    void fetchQuality().then((q) => alive && setQuality(q));
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const header = (
    <PageHeader title="Dashboard" description="Where your store is losing shoppers right now, and what to do first.">
      <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <span aria-hidden="true" className="live-dot" /> Live · updated {updatedAt ? ago(updatedAt) : '-'}
      </span>
    </PageHeader>
  );

  if (!clusters) {
    return (
      <>
        {header}
        <div className="grid gap-3" aria-busy="true" aria-label="Loading the dashboard">
          <div className="grid grid-cols-4 gap-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-80 rounded-xl" />
        </div>
      </>
    );
  }

  const ranked = rankIssues(clusters, findings).filter((r) => !isResolved(r.finding));
  const scored = ranked.flatMap((r) => (r.finding && r.finding.revenue.status === 'ok' ? [{ ...r, finding: r.finding }] : []));
  const currency = scored[0]?.finding.revenue.currency ?? 'INR';
  const atRisk = scored.filter((r) => r.finding.revenue.currency === currency).reduce((n, r) => n + r.finding.revenue.revenue_at_risk_minor, 0);
  const shoppers = ranked.reduce((n, r) => n + r.cluster.session_count, 0);
  const top = ranked.filter((r) => r.finding && r.finding.status === 'open').slice(0, 3);
  const byTier = TIERS.map((t) => ({ tier: t, n: ranked.filter((r) => r.finding?.tier === t).length }));
  const tierTotal = byTier.reduce((n, t) => n + t.n, 0);
  const pending = rules.filter((r) => r.draft);
  const agentPending = pending.filter((r) => r.draft!.origin === 'agent');
  const ownPending = pending.length - agentPending.length;
  const topSuggestions = [...agentPending].sort((a, b) => (b.draft!.revenue_lost?.revenue_at_risk_minor ?? 0) - (a.draft!.revenue_lost?.revenue_at_risk_minor ?? 0)).slice(0, 3);
  const later = clusters.filter((c) => c.found_later && c.found_later.sessions > 0);
  const laterSessions = later.reduce((n, c) => n + (c.found_later?.sessions ?? 0), 0);

  // Revenue at risk by page, biggest first (top 5).
  const pageMap = new Map<string, number>();
  for (const r of scored) pageMap.set(r.cluster.route, (pageMap.get(r.cluster.route) ?? 0) + r.finding.revenue.revenue_at_risk_minor);
  const pages = [...pageMap.entries()]
    .map(([route, revenue]) => ({ route, revenue }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  const s = series.data;
  const approvals = s?.moments.filter((m) => m.kind === 'rule_approved') ?? [];

  return (
    <>
      {header}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <LinkStat href="#/issues" icon={UsersIcon} label="Shoppers affected" value={<AnimatedNumber value={shoppers} />}>
          <span className="text-xs text-muted-foreground">across {ranked.length} open issue{ranked.length === 1 ? '' : 's'}</span>
        </LinkStat>
        <LinkStat href="#/issues" icon={ScrollTextIcon} label="Open issues by priority" value={<AnimatedNumber value={ranked.length} />}>
          {tierTotal > 0 && (
            <div className="mt-1 flex flex-col gap-1.5">
              <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={byTier.map((t) => `${t.tier}: ${t.n}`).join(', ')}>
                {byTier
                  .filter((t) => t.n > 0)
                  .map((t) => (
                    <span key={t.tier} className={cn('motion-grow h-full first:rounded-l-full last:rounded-r-full', TIER_FILL[t.tier])} style={{ width: `${(t.n / tierTotal) * 100}%` }} />
                  ))}
              </div>
              <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                {byTier.map((t) => (
                  <span key={t.tier} className="flex items-center gap-1">
                    <span aria-hidden="true" className={cn('size-2 rounded-full', TIER_FILL[t.tier])} />
                    {t.tier} <b className="font-semibold text-foreground tabular-nums">{t.n}</b>
                  </span>
                ))}
              </div>
            </div>
          )}
        </LinkStat>
        <LinkStat href="#/rules" icon={SparklesIcon} label="Waiting for your approval" value={<AnimatedNumber value={pending.length} />}>
          <span className="flex flex-wrap gap-1.5 text-xs">
            <Badge className="bg-agent-muted text-agent">{agentPending.length} from the agent</Badge>
            <Badge className="bg-info-muted text-info">{ownPending} yours</Badge>
          </span>
        </LinkStat>
        <LinkStat href="#/history" icon={HistoryIcon} label="Found later" value={<AnimatedNumber value={laterSessions} />}>
          <span className="text-xs text-muted-foreground">
            shoppers a new rule found in history{later.length ? `, in ${later.length} issue${later.length === 1 ? '' : 's'}` : ''}
          </span>
        </LinkStat>
      </div>

      <div className="mt-3 grid items-stretch gap-3 lg:grid-cols-[1.7fr_1fr]">
        <Card className="gap-2 px-5">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="flex flex-col">
              <Eyebrow>Revenue at risk now</Eyebrow>
              <span className="text-5xl leading-tight font-bold text-money">
                <AnimatedNumber value={atRisk} format={(n) => money(Math.round(n), currency)} ms={900} />
              </span>
              <span className="text-[13px] text-muted-foreground">
                from {scored.length} scored issue{scored.length === 1 ? '' : 's'}; it falls as issues are fixed
              </span>
            </div>
            <a href="#/history" className="flex items-center gap-1 text-sm font-medium no-underline hover:underline">
              Open time travel <ArrowRightIcon aria-hidden="true" className="size-4" />
            </a>
          </div>
          {s && s.points.some((p) => p.total > 0) ? (
            <>
              <ChartContainer config={revenueConfig} className="aspect-auto h-56 w-full">
                <AreaChart data={s.points} margin={{ top: 8, right: 8, left: 4, bottom: 0 }} onClick={() => (window.location.hash = '#/history')}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="t" type="number" domain={[s.from, s.to]} scale="time" tickFormatter={clock} tickLine={false} axisLine={false} minTickGap={48} />
                  <YAxis tickFormatter={(v: number) => moneyCompact(v, currency)} tickLine={false} axisLine={false} width={56} />
                  <ChartTooltip cursor={{ strokeWidth: 1 }} content={<ChartTooltipContent indicator="line" labelFormatter={(_, p) => clock(Number(p?.[0]?.payload?.t ?? 0))} formatter={(v) => <b className="font-semibold tabular-nums">{money(Number(v), currency)}</b>} />} />
                  {approvals.map((m) => (
                    <ReferenceLine key={`a-${m.at}`} x={m.at} stroke="var(--agent-strong)" strokeWidth={1.5} ifOverflow="discard" />
                  ))}
                  {s.fixes.map((f) => (
                    <ReferenceLine key={`f-${f.id}`} x={f.at} stroke="var(--success-solid)" strokeWidth={1.5} ifOverflow="discard" />
                  ))}
                  <Area dataKey="total" type="stepAfter" stroke="var(--color-total)" strokeWidth={2} fill="var(--color-total)" fillOpacity={0.1} isAnimationActive />
                </AreaChart>
              </ChartContainer>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="h-0.5 w-4 rounded-full bg-agent-strong" />
                  A rule was approved ({approvals.length})
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="h-0.5 w-4 rounded-full bg-success-solid" />
                  An issue was marked fixed ({s.fixes.length})
                </span>
              </div>
            </>
          ) : (
            <Skeleton className="h-56 rounded-lg" aria-label={series.error ? `Could not load the history (${series.error})` : 'Loading the history'} />
          )}
        </Card>

        <Card className="gap-3 px-5">
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-base font-semibold">Fix these first</h2>
            <a href="#/issues" className="flex items-center gap-1 text-sm font-medium no-underline hover:underline">
              All {ranked.length} <ArrowRightIcon aria-hidden="true" className="size-4" />
            </a>
          </div>
          {top.length === 0 ? (
            <p className="m-0 text-sm text-muted-foreground">Nothing scored yet.</p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {top.map(({ cluster: c, finding: f }, i) => (
                <li key={c.cluster_id}>
                  <a
                    href={`#/issues/${c.cluster_id}`}
                    className="issue group/top flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-card-foreground no-underline transition-[border-color,box-shadow] duration-200 hover:border-input hover:shadow-sm"
                  >
                    <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-sm font-semibold tabular-nums">
                      {i + 1}
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-sm font-semibold">{f!.title}</span>
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <TierBadge tier={f!.tier} short /> {c.route} · {c.session_count} shoppers
                      </span>
                    </span>
                    <span className="ml-auto text-right font-semibold whitespace-nowrap text-money tabular-nums">
                      {f!.revenue.status === 'ok' ? money(f!.revenue.revenue_at_risk_minor, f!.revenue.currency) : '…'}
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          )}
          <p className="m-0 mt-auto text-xs text-muted-foreground">Ranked by priority ({TIER_NAMES.P0} first), then revenue.</p>
        </Card>
      </div>

      <div className="mt-3 grid items-start gap-3 lg:grid-cols-3">
        <Card className="gap-2 px-5">
          <h2 className="m-0 text-base font-semibold">Where shoppers hurt</h2>
          <p className="m-0 text-xs text-muted-foreground">Revenue at risk by page</p>
          {pages.length > 0 ? (
            <ChartContainer config={pageConfig} className="aspect-auto w-full" style={{ height: pages.length * 40 + 8 }}>
              <BarChart data={pages} layout="vertical" margin={{ top: 4, right: 72, left: 0, bottom: 4 }} barCategoryGap={8}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="route" tickLine={false} axisLine={false} width={104} tick={{ fontSize: 12 }} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent hideIndicator formatter={(v) => <b className="font-semibold tabular-nums">{money(Number(v), currency)}</b>} />} />
                <Bar dataKey="revenue" fill="var(--color-revenue)" radius={[0, 4, 4, 0]} barSize={18}>
                  <LabelList dataKey="revenue" position="right" className="fill-foreground" fontSize={12} formatter={(v: unknown) => moneyCompact(Number(v), currency)} />
                </Bar>
              </BarChart>
            </ChartContainer>
          ) : (
            <p className="m-0 text-sm text-muted-foreground">No revenue estimates yet.</p>
          )}
        </Card>

        <Card className="gap-3 px-5">
          <div className="flex items-center justify-between">
            <h2 className="m-0 flex items-center gap-1.5 text-base font-semibold">
              <SparklesIcon aria-hidden="true" className="size-4 text-agent" />
              The agent suggests
            </h2>
            <a href="#/rules" className="flex items-center gap-1 text-sm font-medium no-underline hover:underline">
              Review <ArrowRightIcon aria-hidden="true" className="size-4" />
            </a>
          </div>
          {topSuggestions.length === 0 ? (
            <p className="m-0 text-sm text-muted-foreground">Nothing waiting. The agent proposes a rule when shoppers who meet some number leave far more often than the rest.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {topSuggestions.map((r) => (
                <li key={r.rule_id}>
                  <a href="#/rules" className="flex items-center gap-3 rounded-lg border border-dashed border-agent-border bg-card px-3 py-2 text-card-foreground no-underline transition-colors hover:bg-agent-muted">
                    <span className="min-w-0 truncate text-sm font-medium">{r.draft!.watch?.title ?? r.draft!.rule.title}</span>
                    <span className="ml-auto text-sm font-semibold whitespace-nowrap text-money tabular-nums">
                      {r.draft!.revenue_lost?.status === 'ok' ? money(r.draft!.revenue_lost.revenue_at_risk_minor, r.draft!.revenue_lost.currency) : ''}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {agentPending.length > topSuggestions.length && <p className="m-0 text-xs text-muted-foreground">and {agentPending.length - topSuggestions.length} more</p>}
        </Card>

        <Card className="gap-3 px-5">
          <h2 className="m-0 text-base font-semibold">How accurate is this?</h2>
          {quality ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                {(
                  [
                    [`${quality.bugs_found}/${quality.bugs_expected}`, 'planted bugs found'],
                    [String(quality.false_alarms), 'false alarms'],
                    [`${Math.round(quality.lowest_recall * 100)}%`, 'of shoppers caught (worst bug)'],
                    [`${quality.jury.approved}/${quality.jury.reviewed}`, 'AI reports the jury approved'],
                  ] as const
                ).map(([v, l]) => (
                  <div key={l} className="flex flex-col">
                    <span className="text-xl font-semibold tabular-nums">{v}</span>
                    <span className="text-xs text-muted-foreground">{l}</span>
                  </div>
                ))}
              </div>
              <p className="m-0 text-xs text-muted-foreground">
                Measured {ago(quality.checked_at)} on {quality.sessions} test shoppers with planted bugs.
              </p>
            </>
          ) : (
            <p className="m-0 text-sm text-muted-foreground">
              Not measured yet: run <code>pnpm sim:check</code> after a simulated run.
            </p>
          )}
        </Card>
      </div>
    </>
  );
}
