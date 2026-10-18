import { useMemo } from 'react';
import { ArrowDownIcon, ArrowRightIcon, ArrowUpIcon, MinusIcon, TrendUpIcon, WarningIcon } from '@phosphor-icons/react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts';
import { Card } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { AnimatedNumber, Eyebrow, TierBadge } from './components/common';
import { duration, money, moneyCompact } from './format';
import { changeMoments, focusWindow, revenueAt, revenueSeries, trendOf, type SeriesItem, type TrendDirection } from './lib/series';
import type { RevenueSeries } from './lib/useRevenueSeries';

/** One color per issue in the stack, in the warm "loss" family; the last is everything else. Light and dark. */
const COLORS_LIGHT = ['#dc2626', '#ea580c', '#ca8a04', '#db2777', '#7c3aed', '#94a3b8'];
const COLORS_DARK = ['#ef4444', '#f97316', '#eab308', '#ec4899', '#8b5cf6', '#64748b'];

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
 * Money at risk, read at a glance. Top: the total, how it moved, and the two numbers that say how bad it is. Middle: a
 * large chart of the money lost over time, stacked by issue so you can see which problem drove each jump, with the
 * moments rules were approved and issues fixed marked on it. Bottom: the same issues as a ranked list in the chart's
 * colors, each with a "getting worse / better" tag, so the list is also the chart's key.
 */
export function RevenueRanking({ series, open, currency }: { series: RevenueSeries | null; open: OpenIssue[]; currency: string }) {
  const model = useMemo(() => {
    if (!series) return null;
    const openIds = new Set(open.map((o) => o.id));
    const items: SeriesItem[] = series.items.filter((it) => openIds.has(it.id));
    const lanes = series.lanes.filter((l) => openIds.has(l.id));
    const approvals = series.moments.filter((m) => m.kind === 'rule_approved').map((m) => m.at);
    const start = lanes.length ? Math.min(...lanes.map((l) => l.firstHit)) : series.from;
    const lastEvent = Math.max(start, ...lanes.map((l) => l.firstKnown), ...series.fixes.map((f) => f.at), ...approvals);
    const { from, to } = focusWindow(start, lastEvent, series.to);
    // One point per moment something changed, spaced evenly: a quiet night takes no room on the chart.
    const fixTimes = series.fixes.map((f) => f.at);
    const { points, keys } = revenueSeries(items, from, to, 0, 5, changeMoments(items, [...approvals, ...fixTimes], from, to));
    const windowMs = trendWindow(series.from, series.to);
    const byId = new Map(items.map((it) => [it.id, it]));
    const meta = new Map(open.map((o) => [o.id, o]));
    const rows = keys.map((k, i) => {
      const item = k.id ? byId.get(k.id) : null;
      const m = k.id ? meta.get(k.id) : null;
      // "Other" folds the smaller issues together: its trend is the sum of theirs.
      const rest = k.id === null ? items.filter((it) => !keys.some((kk) => kk.id === it.id)) : [];
      const now = item ? revenueAt(item, series.to) : rest.reduce((n, it) => n + revenueAt(it, series.to), 0);
      const before = item ? revenueAt(item, series.to - windowMs) : rest.reduce((n, it) => n + revenueAt(it, series.to - windowMs), 0);
      const trend = item ? trendOf(item, series.to, windowMs).direction : now > before * 1.05 ? 'up' : now < before * 0.95 ? 'down' : 'flat';
      return { key: k.key, i, label: k.label, id: k.id, now, trend: trend as TrendDirection, meta: m };
    });
    const total = items.reduce((n, it) => n + revenueAt(it, series.to), 0);
    const before = items.reduce((n, it) => n + revenueAt(it, series.to - windowMs), 0);
    const worse = items.filter((it) => trendOf(it, series.to, windowMs).direction === 'up' && revenueAt(it, series.to) > 0).length;
    const costing = items.filter((it) => revenueAt(it, series.to) > 0).length;
    return { points, rows, from, to, approvals: approvals.filter((a) => a >= from && a <= to), fixes: series.fixes.filter((f) => f.at >= from && f.at <= to), total, delta: total - before, windowMs, worse, costing };
  }, [series, open]);

  if (!model) return <Skeleton className="h-[34rem] rounded-xl" aria-label="Loading the revenue chart" />;
  const { rows, total, delta, windowMs, worse, costing } = model;
  const top = rows.find((r) => r.id !== null);
  const config: ChartConfig = Object.fromEntries(rows.map((r) => [r.key, { label: r.label, theme: { light: COLORS_LIGHT[r.key === 'other' ? 5 : Math.min(r.i, 4)]!, dark: COLORS_DARK[r.key === 'other' ? 5 : Math.min(r.i, 4)]! } }]));
  const maxNow = Math.max(1, ...rows.map((r) => r.now));

  return (
    <Card className="gap-5 px-6">
      <div className="grid gap-5 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-end">
        <div className="flex flex-col">
          <Eyebrow>Money your store is losing right now</Eyebrow>
          <span className="text-[56px] leading-[1.05] font-semibold tracking-[-0.03em] text-money">
            <AnimatedNumber value={total} format={(n) => money(Math.round(n), currency)} ms={900} />
          </span>
          <span className={cn('flex items-center gap-1 text-[13px] font-medium', delta > 0 ? 'text-money' : delta < 0 ? 'text-success' : 'text-muted-foreground')}>
            {delta > 0 ? <ArrowUpIcon aria-hidden="true" className="size-3.5" /> : delta < 0 ? <ArrowDownIcon aria-hidden="true" className="size-3.5" /> : <MinusIcon aria-hidden="true" className="size-3.5" />}
            {delta === 0 ? 'No change' : `${delta > 0 ? 'Up' : 'Down'} ${money(Math.abs(delta), currency)}`} in the last {duration(windowMs)}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:justify-items-end">
          <div className="flex w-full max-w-60 flex-col gap-0.5 rounded-lg bg-muted/60 px-3.5 py-2.5">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <WarningIcon aria-hidden="true" className="size-3.5" />
              One issue causes
            </span>
            <b className="text-xl font-semibold tabular-nums">{top ? `${Math.round((top.now / Math.max(1, total)) * 100)}%` : '-'}</b>
            <span className="truncate text-xs text-muted-foreground">{top?.label ?? 'of the losses'}</span>
          </div>
          <div className="flex w-full max-w-60 flex-col gap-0.5 rounded-lg bg-muted/60 px-3.5 py-2.5">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <TrendUpIcon aria-hidden="true" className="size-3.5" />
              Getting worse
            </span>
            <b className={cn('text-xl font-semibold tabular-nums', worse > 0 && 'text-money')}>
              {worse} of {costing}
            </b>
            <span className="text-xs text-muted-foreground">issues cost more than {duration(windowMs)} ago</span>
          </div>
        </div>
      </div>

      {total > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="m-0 text-sm font-semibold">Money lost over time, by issue</h3>
            <span className="text-xs text-muted-foreground">Each color is one issue. A jump means it started costing money. Quiet stretches are shortened.</span>
          </div>
          <ChartContainer config={config} className="aspect-auto h-72 w-full">
            <AreaChart data={model.points} margin={{ top: 10, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="t" type="category" tickFormatter={(t: number) => clock(t)} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={64} />
              <YAxis tickFormatter={(v: number) => moneyCompact(v, currency)} tickLine={false} axisLine={false} width={60} />
              <ChartTooltip
                cursor={{ strokeWidth: 1 }}
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    labelFormatter={(_, p) => clock(Number(p?.[0]?.payload?.t ?? 0))}
                    formatter={(v, name) => (
                      <span className="flex w-full items-center justify-between gap-3">
                        <span className="max-w-56 truncate text-muted-foreground">{config[String(name)]?.label}</span>
                        <b className="font-semibold tabular-nums">{money(Number(v), currency)}</b>
                      </span>
                    )}
                  />
                }
              />
              {[...rows].reverse().map((r) => (
                <Area key={r.key} dataKey={r.key} stackId="loss" type="monotone" stroke="var(--card)" strokeWidth={1.5} fill={`var(--color-${r.key})`} fillOpacity={0.9} isAnimationActive={false} />
              ))}
              {model.approvals.map((a) => (
                <ReferenceLine key={`a-${a}`} x={a} stroke="var(--agent-strong)" strokeWidth={1.5} strokeDasharray="4 3" ifOverflow="discard" />
              ))}
              {model.fixes.map((f) => (
                <ReferenceLine key={`f-${f.id}`} x={f.at} stroke="var(--success-solid)" strokeWidth={1.5} strokeDasharray="4 3" ifOverflow="discard" />
              ))}
            </AreaChart>
          </ChartContainer>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-0.5 w-4 rounded-full bg-agent-strong" />A rule was approved ({model.approvals.length})
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-0.5 w-4 rounded-full bg-success-solid" />
              An issue was fixed ({model.fixes.length})
            </span>
          </div>
        </div>
      ) : (
        <p className="m-0 text-sm text-muted-foreground">No issue has a money estimate yet. They appear here once shoppers who left are counted.</p>
      )}

      <ol className="m-0 grid list-none gap-x-6 gap-y-1 p-0 xl:grid-cols-2">
        {rows.map((r) => {
          const t = TREND[r.trend];
          const Row = r.id ? 'a' : 'div';
          return (
            <li key={r.key}>
              <Row
                {...(r.id ? { href: `#/issues/${r.id}` } : {})}
                className={cn('grid grid-cols-[0.75rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2 text-foreground no-underline', r.id && 'transition-colors hover:bg-muted/50')}
              >
                <span aria-hidden="true" className="size-3 rounded-[3px]" style={{ background: `var(--color-${r.key})` }} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-semibold">{r.label}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {r.meta ? (
                      <>
                        <TierBadge tier={r.meta.tier} short /> {r.meta.route} · {r.meta.shoppers} shoppers
                      </>
                    ) : (
                      'the smaller ones added together'
                    )}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-0.5">
                  <b className="text-base font-semibold whitespace-nowrap text-money tabular-nums">{moneyCompact(r.now, currency)}</b>
                  <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium', t.cls)}>
                    <t.Icon aria-hidden="true" className="size-3" />
                    {t.label}
                  </span>
                </span>
                <span className="col-span-3 -mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <span className="motion-grow block h-full rounded-full" style={{ width: `${Math.max(2, (r.now / maxNow) * 100)}%`, background: `var(--color-${r.key})` }} />
                </span>
              </Row>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>“Getting worse” compares with {duration(windowMs)} ago. Bars are sized against the biggest issue.</span>
        <a href="#/history" className="flex items-center gap-1 font-medium no-underline hover:underline">
          See how long each one went unnoticed <ArrowRightIcon aria-hidden="true" className="size-3.5" />
        </a>
      </div>
    </Card>
  );
}
