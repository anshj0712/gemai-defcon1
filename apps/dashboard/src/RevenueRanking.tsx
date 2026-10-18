import { ArrowDownIcon, ArrowRightIcon, ArrowUpIcon, MinusIcon } from '@phosphor-icons/react';
import { Area, AreaChart, XAxis, YAxis } from 'recharts';
import { Card } from '@/components/ui/card';
import { ChartContainer, type ChartConfig } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { AnimatedNumber, Eyebrow, TierBadge } from './components/common';
import { duration, money, moneyCompact } from './format';
import { revenueAt, trendOf, type SeriesItem, type TrendDirection } from './lib/series';
import type { RevenueSeries } from './lib/useRevenueSeries';

const config = { total: { label: 'Money at risk', color: 'var(--money)' } } satisfies ChartConfig;
const TIER_BAR: Record<string, string> = { P0: 'bg-tier-p0', P1: 'bg-tier-p1', P2: 'bg-tier-p2', P3: 'bg-tier-p3' };

const TREND: Record<TrendDirection, { label: string; cls: string; Icon: typeof ArrowUpIcon }> = {
  up: { label: 'Getting worse', cls: 'bg-danger-muted text-money', Icon: ArrowUpIcon },
  down: { label: 'Getting better', cls: 'bg-success-muted text-success', Icon: ArrowDownIcon },
  flat: { label: 'Steady', cls: 'bg-muted text-muted-foreground', Icon: MinusIcon },
};

/** How far back "getting worse / better" looks: a third of the record, between 5 minutes and 1 hour. */
export const trendWindow = (from: number, to: number) => Math.min(3_600_000, Math.max(300_000, (to - from) / 3));

export interface OpenIssue {
  id: string;
  title: string;
  route: string;
  tier: string;
  shoppers: number;
}

/**
 * Money at risk, made readable: the total with how it moved, then every open issue as a bar sized by the money it
 * costs, biggest first, each with a "getting worse / better" tag. Replaces a stacked area that showed shape but not
 * what to do about it.
 */
export function RevenueRanking({ series, open, currency }: { series: RevenueSeries | null; open: OpenIssue[]; currency: string }) {
  if (!series) return <Skeleton className="h-80 rounded-xl" aria-label="Loading the revenue chart" />;
  const windowMs = trendWindow(series.from, series.to);
  const openIds = new Set(open.map((o) => o.id));
  const byId = new Map<string, SeriesItem>(series.items.map((it) => [it.id, it]));
  const rows = open
    .map((o) => {
      const item = byId.get(o.id);
      return { ...o, now: item ? revenueAt(item, series.to) : 0, trend: item ? trendOf(item, series.to, windowMs) : null };
    })
    .filter((r) => r.now > 0)
    .sort((a, b) => b.now - a.now)
    .slice(0, 6);
  const openItems = series.items.filter((it) => openIds.has(it.id));
  const total = openItems.reduce((n, it) => n + revenueAt(it, series.to), 0);
  const before = openItems.reduce((n, it) => n + revenueAt(it, series.to - windowMs), 0);
  const delta = total - before;
  const max = rows[0]?.now ?? 1;
  const shown = rows.reduce((n, r) => n + r.now, 0);

  return (
    <Card className="gap-4 px-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col">
          <Eyebrow>Money your store is losing right now</Eyebrow>
          <span className="text-[52px] leading-[1.05] font-semibold tracking-[-0.03em] text-money">
            <AnimatedNumber value={total} format={(n) => money(Math.round(n), currency)} ms={900} />
          </span>
          <span className={cn('flex items-center gap-1 text-[13px] font-medium', delta > 0 ? 'text-money' : delta < 0 ? 'text-success' : 'text-muted-foreground')}>
            {delta > 0 ? <ArrowUpIcon aria-hidden="true" className="size-3.5" /> : delta < 0 ? <ArrowDownIcon aria-hidden="true" className="size-3.5" /> : <MinusIcon aria-hidden="true" className="size-3.5" />}
            {delta === 0 ? 'No change' : `${delta > 0 ? 'Up' : 'Down'} ${money(Math.abs(delta), currency)}`} in the last {duration(windowMs)}
          </span>
        </div>
        <div className="w-44 max-w-full" aria-hidden="true">
          <ChartContainer config={config} className="aspect-auto h-14 w-full">
            <AreaChart data={series.points} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
              <XAxis dataKey="t" type="number" domain={[series.from, series.to]} hide />
              <YAxis hide domain={[0, 'dataMax']} />
              <Area dataKey="total" type="monotone" stroke="var(--color-total)" strokeWidth={2} fill="var(--color-total)" fillOpacity={0.12} isAnimationActive={false} />
            </AreaChart>
          </ChartContainer>
          <span className="block text-right text-[11px] text-muted-foreground">trend since the first alert</span>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">No issue has a money estimate yet. They appear here once shoppers who left are counted.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
          {rows.map((r, i) => {
            const t = TREND[r.trend?.direction ?? 'flat'];
            return (
              <li key={r.id}>
                <a
                  href={`#/issues/${r.id}`}
                  className="group/row grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 text-foreground no-underline transition-colors hover:bg-muted/50 sm:grid-cols-[1.25rem_minmax(0,1.1fr)_minmax(0,1.4fr)_auto]"
                >
                  <span aria-hidden="true" className="text-sm font-medium text-muted-foreground tabular-nums">
                    {i + 1}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-semibold">{r.title}</span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <TierBadge tier={r.tier} short /> {r.route} · {r.shoppers} shoppers
                    </span>
                  </span>
                  <span className="col-span-2 flex items-center gap-2 sm:col-span-1" role="img" aria-label={`${money(r.now, currency)}, ${Math.round((r.now / Math.max(1, total)) * 100)}% of the total`}>
                    <span className="h-3 flex-1 overflow-hidden rounded-full bg-muted">
                      <span className={cn('motion-grow block h-full rounded-full', TIER_BAR[r.tier] ?? 'bg-tier-p3')} style={{ width: `${Math.max(3, (r.now / max) * 100)}%` }} />
                    </span>
                  </span>
                  <span className="col-span-2 flex items-center justify-between gap-3 sm:col-span-1 sm:flex-col sm:items-end sm:gap-0.5">
                    <b className="text-base font-semibold whitespace-nowrap text-money tabular-nums">{moneyCompact(r.now, currency)}</b>
                    <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium', t.cls)}>
                      <t.Icon aria-hidden="true" className="size-3" />
                      {t.label}
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {rows.length > 0 && (
            <>
              The top {rows.length} issue{rows.length === 1 ? '' : 's'} are {Math.round((shown / Math.max(1, total)) * 100)}% of the money lost.{' '}
            </>
          )}
          “Getting worse” compares with {duration(windowMs)} ago.
        </span>
        <a href="#/history" className="flex items-center gap-1 font-medium no-underline hover:underline">
          See how long each one went unnoticed <ArrowRightIcon aria-hidden="true" className="size-3.5" />
        </a>
      </div>
    </Card>
  );
}
