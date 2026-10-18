import { useEffect, useState, type ReactNode } from 'react';
import type { FindingSummary } from '@cp/schema';
import { ArrowRightIcon, ClockCounterClockwiseIcon, ScrollIcon, DetectiveIcon, UsersIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { Bar, BarChart, LabelList, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { fetchClusters, fetchFindings, fetchQuality, fetchRules, type ClusterSummary, type QualityReport, type RuleView } from './api';
import { AnimatedNumber, PageHeader, TierBadge } from './components/common';
import { ago, isResolved, money, moneyCompact } from './format';
import { rankIssues } from './lib/issues';
import { keep, peek } from './lib/swr';
import { useRevenueSeries } from './lib/useRevenueSeries';
import { RevenueRanking } from './RevenueRanking';

const REFRESH_MS = 5000;
const TIERS = ['P0', 'P1', 'P2', 'P3'] as const;
const TIER_FILL: Record<string, string> = { P0: 'bg-tier-p0', P1: 'bg-tier-p1', P2: 'bg-tier-p2', P3: 'bg-tier-p3' };

const pageConfig = { revenue: { label: 'Money at risk', color: 'var(--money)' } } satisfies ChartConfig;

/** A KPI card that leads somewhere. */
function LinkStat({ href, icon: Icon, label, value, children }: { href: string; icon: typeof UsersIcon; label: string; value: ReactNode; children?: ReactNode }) {
  return (
    <a href={href} className="group/stat flex flex-col gap-1 rounded-xl bg-card px-4 py-3 text-card-foreground no-underline ring-1 ring-border transition-[box-shadow,translate] duration-200 ease-out-expo hover:shadow-[0_10px_28px_-16px_rgb(15_23_42/0.35)] hover:ring-input motion-safe:hover:-translate-y-px">
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
  // Each state starts from the last answer this tab saw, so coming back to the Dashboard shows numbers at once.
  const [clusters, setClusters] = useState<ClusterSummary[] | null>(() => peek<ClusterSummary[]>('dash:clusters') ?? null);
  const [findings, setFindings] = useState<FindingSummary[]>(() => peek<FindingSummary[]>('dash:findings') ?? []);
  const [rules, setRules] = useState<RuleView[]>(() => peek<RuleView[]>('dash:rules') ?? []);
  const [quality, setQuality] = useState<QualityReport | null>(() => peek<QualityReport>('dash:quality') ?? null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(() => peek<number>('dash:at') ?? null);
  const series = useRevenueSeries();

  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all([fetchClusters(), fetchFindings().catch(() => ({ findings: [] as FindingSummary[] })), fetchRules().catch(() => ({ rules: [] as RuleView[] }))]).then(
        ([c, f, r]) => {
          if (!alive) return;
          setClusters(keep('dash:clusters', c.clusters));
          setFindings(keep('dash:findings', f.findings));
          setRules(keep('dash:rules', r.rules));
          setUpdatedAt(keep('dash:at', Date.now()));
        },
        () => undefined,
      );
    void load();
    void fetchQuality().then((q) => alive && setQuality(q && keep('dash:quality', q)));
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const header = (
    <PageHeader title="Dashboard" description="How much money your store is losing to bugs right now, and which ones to fix first.">
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
  // The three open issues that cost the most money, biggest first.
  const fixFirst = ranked
    .flatMap((r) => (r.finding && r.finding.status === 'open' && r.finding.revenue.status === 'ok' ? [{ cluster: r.cluster, finding: r.finding, minor: r.finding.revenue.revenue_at_risk_minor }] : []))
    .sort((a, b) => b.minor - a.minor)
    .slice(0, 3);
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

  return (
    <>
      {header}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <LinkStat href="#/issues" icon={UsersIcon} label="Shoppers affected" value={<AnimatedNumber value={shoppers} />}>
          <span className="text-xs text-muted-foreground">across {ranked.length} open issue{ranked.length === 1 ? '' : 's'}</span>
        </LinkStat>
        <LinkStat href="#/issues" icon={ScrollIcon} label="Open issues by priority" value={<AnimatedNumber value={ranked.length} />}>
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
        <LinkStat href="#/rules" icon={DetectiveIcon} label="Waiting for your approval" value={<AnimatedNumber value={pending.length} />}>
          <span className="flex flex-wrap gap-1.5 text-xs">
            <Badge className="bg-agent-muted text-agent">{agentPending.length} from the agent</Badge>
            <Badge className="bg-info-muted text-info">{ownPending} yours</Badge>
          </span>
        </LinkStat>
        <LinkStat href="#/history" icon={ClockCounterClockwiseIcon} label="Found later" value={<AnimatedNumber value={laterSessions} />}>
          <span className="text-xs text-muted-foreground">
            shoppers a new rule found in history{later.length ? `, in ${later.length} issue${later.length === 1 ? '' : 's'}` : ''}
          </span>
        </LinkStat>
      </div>

      <div className="mt-3 grid items-start gap-3 lg:grid-cols-[1.7fr_1fr]">
        <RevenueRanking
          series={series.data}
          currency={currency}
          open={ranked.flatMap((r) => (r.finding ? [{ id: r.cluster.cluster_id, title: r.finding.title, route: r.cluster.route, tier: r.finding.tier, shoppers: r.cluster.session_count }] : []))}
        />

        <Card className="gap-3 bg-danger-muted/45 px-5 ring-danger-border/80">
          <div className="flex items-center justify-between gap-2">
            <h2 className="m-0 flex items-center gap-1.5 text-base font-semibold text-money">
              <WarningCircleIcon aria-hidden="true" weight="fill" className="size-5" />
              Fix these first
            </h2>
            <a href="#/issues" className="flex items-center gap-1 text-sm font-medium no-underline hover:underline">
              All {ranked.length} <ArrowRightIcon aria-hidden="true" className="size-4" />
            </a>
          </div>
          {fixFirst.length === 0 ? (
            <p className="m-0 text-sm text-muted-foreground">Nothing to fix yet. Issues appear here once shoppers hit a problem.</p>
          ) : (
            <>
              <p className="m-0 text-[13px] text-foreground/80">These lose the most money. Start with number 1.</p>
              <ol className="m-0 flex list-none flex-col gap-2 p-0">
                {fixFirst.map(({ cluster: c, finding: f, minor }, i) => (
                  <li key={c.cluster_id}>
                    <a
                      href={`#/issues/${c.cluster_id}`}
                      className="group/top flex flex-col gap-1.5 rounded-lg bg-card px-3 py-2.5 text-card-foreground no-underline ring-1 ring-danger-border/70 transition-[box-shadow,background-color] duration-200 hover:bg-card/80 hover:ring-tier-p0/60"
                    >
                      <span className="flex items-start gap-2.5">
                        <span aria-hidden="true" className="mt-px grid size-6 shrink-0 place-items-center rounded-md bg-tier-p0 text-[13px] font-semibold text-tier-foreground tabular-nums">
                          {i + 1}
                        </span>
                        <span className="min-w-0 flex-1 text-sm leading-snug font-semibold">{f.title}</span>
                        <b className="text-base font-semibold whitespace-nowrap text-money tabular-nums">{money(minor, f.revenue.currency)}</b>
                      </span>
                      <span className="flex items-center gap-2 pl-[34px] text-xs text-muted-foreground">
                        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <span className="motion-grow block h-full rounded-full bg-tier-p0" style={{ width: `${Math.max(4, (minor / Math.max(1, atRisk)) * 100)}%` }} />
                        </span>
                        <span className="whitespace-nowrap tabular-nums">{Math.round((minor / Math.max(1, atRisk)) * 100)}% of all losses</span>
                      </span>
                      <span className="flex items-center gap-1.5 pl-[34px] text-xs text-muted-foreground">
                        <TierBadge tier={f.tier} short /> {c.route} · {c.session_count} shoppers
                      </span>
                    </a>
                  </li>
                ))}
              </ol>
            </>
          )}
          <p className="m-0 mt-auto text-xs text-muted-foreground">Sorted by money lost, biggest first.</p>
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
              <DetectiveIcon aria-hidden="true" className="size-4 text-agent" />
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
                  <a href="#/rules" className="flex items-center gap-3 rounded-lg bg-card px-3 py-2 text-card-foreground no-underline ring-1 ring-agent-border/70 transition-colors duration-200 hover:bg-agent-muted">
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
