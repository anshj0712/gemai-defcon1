import { useEffect, useState } from 'react';
import { DetectiveIcon, UserIcon } from '@phosphor-icons/react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ChartContainer, ChartLegend, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fetchClusters, fetchRules, type ClusterSummary, type RuleView } from './api';
import { ago, money, moneyCompact } from './format';
import { useRevenueSeries } from './lib/useRevenueSeries';
import { liveOrigin } from './lib/rules';

/**
 * The categorical order for stacked issues: the calm palette's six slots, validated with the dataviz checker on this
 * chart's surfaces (light on #ffffff, dark on #1c1b19; lightness band, chroma floor, adjacent CVD and normal-vision
 * gates pass; the ochre's sub-3:1 contrast in light is relieved by the legend, tooltip and the issue lists below).
 * The sixth slot is "Other".
 */
const SERIES_LIGHT = ['#3d6fa8', '#c4663a', '#1f9479', '#c29530', '#b5628a', '#62801f'];
const SERIES_DARK = ['#5f8fc9', '#d27a4c', '#2fa587', '#b08530', '#c9739b', '#7a9b31'];

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Revenue at risk over time, stacked by issue, from the findings record: it climbs as shoppers hit problems and as
 * re-scans find past ones, and drops when an issue is marked fixed. Violet lines are rule approvals, green lines fixes,
 * the dark line is the moment below; clicking the chart moves that moment.
 */
export function RevenueTimeline({ asOf, onPick }: { asOf: number | null; onPick: (t: number) => void }) {
  const { data, error } = useRevenueSeries();
  if (!data) return <Skeleton className="h-72 rounded-xl" aria-label={error ? `Could not load the history (${error})` : 'Loading the history'} />;
  const currency = data.findings[0]?.revenue.currency ?? 'INR';
  const config: ChartConfig = Object.fromEntries(
    data.keys.map((k, i) => {
      const slot = k.key === 'other' ? 5 : Math.min(i, 4);
      return [k.key, { label: k.label, theme: { light: SERIES_LIGHT[slot]!, dark: SERIES_DARK[slot]! } }];
    }),
  );
  const approvals = data.moments.filter((m) => m.kind === 'rule_approved');
  return (
    <Card className="gap-2 px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-base font-semibold">Revenue at risk over time</h2>
        <span className="text-xs text-muted-foreground">Click the chart to see what was known at that moment.</span>
      </div>
      {data.keys.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">No revenue estimates on record yet.</p>
      ) : (
        <ChartContainer config={config} className="aspect-auto h-72 w-full">
          <AreaChart
            data={data.points}
            margin={{ top: 8, right: 8, left: 4, bottom: 0 }}
            onClick={(s: { activeLabel?: string | number } | null) => {
              const t = Number(s?.activeLabel);
              if (Number.isFinite(t)) onPick(t);
            }}
          >
            <CartesianGrid vertical={false} />
            <XAxis dataKey="t" type="number" domain={[data.from, data.to]} scale="time" tickFormatter={clock} tickLine={false} axisLine={false} minTickGap={48} />
            <YAxis tickFormatter={(v: number) => moneyCompact(v, currency)} tickLine={false} axisLine={false} width={56} />
            <ChartTooltip
              cursor={{ strokeWidth: 1 }}
              content={<ChartTooltipContent indicator="line" labelFormatter={(_, p) => clock(Number(p?.[0]?.payload?.t ?? 0))} formatter={(v, name) => (
                <span className="flex w-full items-center justify-between gap-3">
                  <span className="max-w-56 truncate text-muted-foreground">{config[String(name)]?.label}</span>
                  <b className="font-semibold tabular-nums">{money(Number(v), currency)}</b>
                </span>
              )} />}
            />
            {/* The areas' stroke is the 2px surface gap, so the legend keys each series by its fill instead. */}
            <ChartLegend
              content={() => (
                <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-3 text-xs text-muted-foreground">
                  {data.keys.map((k) => (
                    <span key={k.key} className="flex items-center gap-1.5">
                      <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[2px]" style={{ background: `var(--color-${k.key})` }} />
                      {k.label}
                    </span>
                  ))}
                </div>
              )}
            />
            {data.keys.map((k) => (
              <Area key={k.key} dataKey={k.key} stackId="revenue" type="stepAfter" stroke="var(--card)" strokeWidth={2} fill={`var(--color-${k.key})`} fillOpacity={0.85} isAnimationActive />
            ))}
            {approvals.map((m) => (
              <ReferenceLine key={`a-${m.at}`} x={m.at} stroke="var(--agent-strong)" strokeWidth={1.5} ifOverflow="discard" />
            ))}
            {data.fixes.map((f) => (
              <ReferenceLine key={`f-${f.id}`} x={f.at} stroke="var(--success-solid)" strokeWidth={1.5} ifOverflow="discard" />
            ))}
            {asOf !== null && <ReferenceLine x={asOf} stroke="var(--foreground)" strokeWidth={1} ifOverflow="discard" />}
          </AreaChart>
        </ChartContainer>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-0.5 w-4 rounded-full bg-agent-strong" />A rule was approved ({approvals.length})
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-0.5 w-4 rounded-full bg-success-solid" />
          An issue was marked fixed ({data.fixes.length})
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-0.5 w-4 rounded-full bg-foreground" />
          The moment below
        </span>
      </div>
    </Card>
  );
}

/**
 * What each rule did, rule by rule: who proposed it, when it went live, how many past shoppers its re-scan found, and
 * what its issue puts at risk now. This is the table view of the chart's rule markers.
 */
export function RuleImpact() {
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const { data } = useRevenueSeries();
  useEffect(() => {
    let alive = true;
    void Promise.all([fetchRules(), fetchClusters()]).then(
      ([r, c]) => alive && (setRules(r.rules), setClusters(c.clusters)),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  if (!rules) return null;
  const withHistory = rules.filter((r) => r.active || (r.undone && r.undone.length > 0));
  if (withHistory.length === 0) return null;
  const findingFor = (ruleId: string) => {
    const c = clusters.find((x) => x.kind === 'invariant' && x.anchor === ruleId);
    return c ? (data?.findings.find((f) => f.cluster_id === c.cluster_id) ?? null) : null;
  };
  return (
    <Card className="gap-2 px-5">
      <h2 className="m-0 text-base font-semibold">By rule</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Rule</TableHead>
            <TableHead>Proposed by</TableHead>
            <TableHead>Live since</TableHead>
            <TableHead className="text-right">Found in history</TableHead>
            <TableHead className="text-right">At risk on its issue now</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {withHistory.map((r) => {
            const f = findingFor(r.rule_id);
            const origin = liveOrigin(r);
            return (
              <TableRow key={r.rule_id}>
                <TableCell className="font-medium whitespace-normal">
                  {r.title}
                  {!r.active && (
                    <Badge variant="secondary" className="ml-2">
                      switched off
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {origin === 'agent' ? (
                    <Badge className="gap-1 bg-agent-muted text-agent">
                      <DetectiveIcon data-icon="inline-start" aria-hidden="true" />
                      Agent
                    </Badge>
                  ) : (
                    <Badge className="gap-1 bg-info-muted text-info">
                      <UserIcon data-icon="inline-start" aria-hidden="true" />
                      You
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{r.active ? ago(r.active.approved_at) : '-'}</TableCell>
                <TableCell className="text-right font-semibold text-agent tabular-nums">{r.rescan ? r.rescan.sessions_hit : '-'}</TableCell>
                <TableCell className="text-right font-semibold text-money tabular-nums">
                  {f && f.revenue.status === 'ok' ? (
                    <a href={`#/issues/${f.cluster_id}`} className="text-money">
                      {money(f.revenue.revenue_at_risk_minor, f.revenue.currency)}
                    </a>
                  ) : (
                    '-'
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
