import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { duration, money, moneyCompact } from './format';
import { focusWindow, type Lane } from './lib/series';
import { useRevenueSeries } from './lib/useRevenueSeries';

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const MIN_SPAN_MS = 600_000;
const MAX_LANES = 8;

const STRIPES = 'bg-[repeating-linear-gradient(135deg,var(--tier-p0)_0_4px,color-mix(in_oklab,var(--tier-p0)_35%,transparent)_4px_8px)]';

/**
 * How long each problem went unnoticed. One row per issue; the red striped part is the time shoppers were being hurt
 * before the system knew (a newer rule found it later, or the first alert came late), the blue part is the time it
 * was known and still costing money, and a green tick is the moment it was fixed. Violet lines are rule approvals.
 * Click anywhere on a row to see what was known at that moment.
 */
export function DetectionLanes({ asOf, onPick }: { asOf: number | null; onPick: (t: number) => void }) {
  const { data, error } = useRevenueSeries();
  const lanes: Lane[] = useMemo(() => data?.lanes.slice(0, MAX_LANES) ?? [], [data]);
  if (!data) return <Skeleton className="h-72 rounded-xl" aria-label={error ? `Could not load the history (${error})` : 'Loading the history'} />;

  const currency = data.findings[0]?.revenue.currency ?? 'INR';
  const start = lanes.length ? Math.min(...lanes.map((l) => l.firstHit)) : data.from;
  // Zoom in on where things happened: from the first hit to the last event (an alert, a fix, a rule), with some room
  // after it. Without this, an issue open for a day squashes every minute that mattered into a sliver.
  const approvalTimes = data.moments.filter((m) => m.kind === 'rule_approved').map((m) => m.at);
  const lastEvent = Math.max(start, ...lanes.flatMap((l) => [l.firstKnown, l.fixedAt ?? 0]), ...approvalTimes);
  const { from, to } = focusWindow(start, lastEvent, data.to, MIN_SPAN_MS);
  const span = to - from;
  const x = (t: number) => Math.min(100, Math.max(0, ((t - from) / span) * 100));
  const ticks = Array.from({ length: 5 }, (_, i) => from + (span * i) / 4);
  const approvals = data.moments.filter((m) => m.kind === 'rule_approved' && m.at >= from);
  const worst = [...lanes].filter((l) => l.blindMs > 0).sort((a, b) => b.blindMs - a.blindMs)[0];

  return (
    <Card className="gap-3 px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-base font-semibold">How long each problem went unnoticed</h2>
        <span className="text-xs text-muted-foreground">Click a row to see what we knew at that moment.</span>
      </div>
      {worst ? (
        <p className="m-0 text-sm">
          <b className="font-semibold text-money">{worst.title}</b> hurt shoppers for <b className="font-semibold">{duration(worst.blindMs)}</b> before we noticed it.
        </p>
      ) : (
        <p className="m-0 text-sm text-muted-foreground">Every issue was caught as soon as shoppers hit it.</p>
      )}

      {lanes.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">No issues on record yet.</p>
      ) : (
        <div className="grid grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          <span />
          <div className="relative h-4 text-[11px] text-muted-foreground" aria-hidden="true">
            {ticks.map((t, i) => (
              <span
                key={t}
                className="absolute whitespace-nowrap tabular-nums"
                style={{ left: `${x(t)}%`, transform: i === 0 ? 'none' : i === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}
              >
                {clock(t)}
              </span>
            ))}
          </div>
          {lanes.map((l) => {
            const knownEnd = l.fixedAt ?? to;
            return (
              <div key={l.id} className="contents">
                <a href={`#/issues/${l.id}`} className="flex min-w-0 flex-col justify-center text-foreground no-underline hover:underline">
                  <span className="truncate text-[13px] font-medium">{l.title}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {moneyCompact(l.revenueMinor, currency)} at risk{l.blindMs > 0 ? ` · unseen ${duration(l.blindMs)}` : ''}
                  </span>
                </a>
                <button
                  type="button"
                  className="relative h-9 cursor-crosshair overflow-hidden rounded-md bg-muted/60 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`${l.title}: shoppers first hit it at ${clock(l.firstHit)}, noticed at ${clock(l.firstKnown)}${l.fixedAt ? `, fixed at ${clock(l.fixedAt)}` : ''}`}
                  onClick={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    onPick(from + ((e.clientX - box.left) / box.width) * span);
                  }}
                >
                  {l.blindMs > 0 && (
                    <span
                      className={cn('absolute inset-y-1 rounded-sm', STRIPES)}
                      style={{ left: `${x(l.firstHit)}%`, width: `${Math.max(0.6, x(l.firstKnown) - x(l.firstHit))}%` }}
                      title={`Shoppers were hurt from ${clock(l.firstHit)}, but we only knew from ${clock(l.firstKnown)}`}
                    />
                  )}
                  <span
                    className="absolute inset-y-1 flex items-center justify-end rounded-sm bg-primary/75 pr-1.5 text-[10px] font-medium text-primary-foreground"
                    style={{ left: `${x(l.firstKnown)}%`, width: `${Math.max(0.6, x(knownEnd) - x(l.firstKnown))}%` }}
                    title={`Known and costing money from ${clock(l.firstKnown)}`}
                  >
                    {l.fixedAt === null && x(knownEnd) - x(l.firstKnown) > 14 && 'still open →'}
                  </span>
                  {l.fixedAt !== null && (
                    <span className="absolute inset-y-0 grid w-4 -translate-x-1/2 place-items-center rounded-full bg-success-solid text-[10px] font-bold text-white" style={{ left: `${x(l.fixedAt)}%` }} title={`Marked fixed at ${clock(l.fixedAt)}`}>
                      ✓
                    </span>
                  )}
                  {approvals.map((m) => (
                    <span key={`${l.id}-${m.at}`} aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-0.5 bg-agent-strong" style={{ left: `${x(m.at)}%` }} />
                  ))}
                  {asOf !== null && asOf >= from && asOf <= to && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-0.5 bg-foreground" style={{ left: `${x(asOf)}%` }} />}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <Key swatch={STRIPES} label="Shoppers hurt, not yet noticed" />
        <Key swatch="bg-primary/75" label="Noticed, still costing money" />
        <Key swatch="bg-success-solid" label="Marked fixed" />
        <Key swatch="bg-agent-strong" label={`A rule was approved (${approvals.length})`} line />
        <Key swatch="bg-foreground" label="The moment you picked" line />
      </div>
      <p className="m-0 text-xs text-muted-foreground">
        Why this matters: a rule you approve today can find shoppers it would have caught last week. The striped part is that hidden damage
        {worst ? ` (${money(worst.revenueMinor, currency)} on the worst one)` : ''}.
      </p>
    </Card>
  );
}

function Key({ swatch, label, line }: { swatch: string; label: string; line?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden="true" className={cn('shrink-0 rounded-[2px]', line ? 'h-3.5 w-0.5' : 'size-3', swatch)} />
      {label}
    </span>
  );
}
