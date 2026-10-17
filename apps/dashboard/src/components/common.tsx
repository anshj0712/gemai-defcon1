import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { symptomColor, symptomName, TIER_NAMES } from '../format';

/** Small building blocks shared by the pages. Colors are tokens (see index.css), and every color sits next to text. */

const TIER_CLASS: Record<string, string> = { P0: 'bg-tier-p0', P1: 'bg-tier-p1', P2: 'bg-tier-p2', P3: 'bg-tier-p3' };

/** "P0 · blocker" on the tier's fill; `short` shows just "P0". */
export function TierBadge({ tier, short, className }: { tier: string; short?: boolean; className?: string }) {
  return <Badge className={cn('font-bold tracking-[0.02em] text-tier-foreground', TIER_CLASS[tier] ?? 'bg-tier-p3', className)}>{short ? tier : (TIER_NAMES[tier] ?? tier)}</Badge>;
}

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * A number that rolls to its new value when it changes (and up from zero when it first appears), so a live
 * total visibly moves when new sessions arrive. Exponential ease-out over `ms`; instant under reduced motion.
 */
export function AnimatedNumber({ value, format = (n) => Math.round(n).toLocaleString('en-IN'), ms = 700 }: { value: number; format?: (n: number) => string; ms?: number }) {
  const [shown, setShown] = useState(() => (reducedMotion() ? value : 0));
  const from = useRef(shown);
  useEffect(() => {
    if (reducedMotion() || from.current === value) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = t === 1 ? 1 : 1 - 2 ** (-10 * t);
      const v = a + (value - a) * eased;
      from.current = v;
      setShown(v);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, ms]);
  return <span className="tabular-nums">{format(shown)}</span>;
}

export function PendingTierBadge() {
  return (
    <Badge variant="secondary" className="text-muted-foreground">
      Scoring…
    </Badge>
  );
}

/** Element issues (a control on a page, indigo) or data-rule issues (a number that broke a rule, purple). */
export function KindBadge({ kind }: { kind: string }) {
  return (
    <Badge className={cn('text-[11px] font-semibold tracking-[0.04em] uppercase', kind === 'invariant' ? 'bg-agent-muted text-agent' : 'bg-kind-muted text-kind')}>
      {kind === 'invariant' ? 'Data rule' : 'Element'}
    </Badge>
  );
}

/** A symptom with its count, outlined in the same color as the replay timeline's flag for that detector. */
export function SymptomChip({ detector, count }: { detector: string; count?: number }) {
  const color = symptomColor(detector);
  return (
    <Badge variant="outline" className="border-[1.5px] bg-card font-semibold" style={{ borderColor: color, color }}>
      {symptomName(detector)}
      {count !== undefined && <span className="tabular-nums">· {count}</span>}
    </Badge>
  );
}

export function NeedsReviewBadge({ title }: { title?: string }) {
  return (
    <Badge className="bg-danger-muted text-money" title={title}>
      Needs review
    </Badge>
  );
}

/** Sessions a re-scan added after a newer rule: the found-later tag (agent violet, like the time-travel highlights). */
export function FoundLaterBadge({ children, href, title }: { children: ReactNode; href?: string; title?: string }) {
  const cls = 'bg-agent-muted text-agent';
  return href ? (
    <Badge asChild className={cn(cls, 'no-underline')} title={title}>
      <a href={href}>{children}</a>
    </Badge>
  ) : (
    <Badge className={cls} title={title}>
      {children}
    </Badge>
  );
}

/** A KPI tile: one number and what it counts. */
export function Stat({ value, label, tone, aside, className }: { value: ReactNode; label: ReactNode; tone?: 'money' | 'agent'; aside?: ReactNode; className?: string }) {
  return (
    <Card size="sm" className={cn('min-w-40 gap-0.5 px-4', className)}>
      <span className={cn('text-2xl leading-tight font-semibold tabular-nums', tone === 'money' && 'text-money', tone === 'agent' && 'text-agent')}>{value}</span>
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {aside}
    </Card>
  );
}

/** Uppercase section label, muted. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('text-xs font-semibold tracking-wider text-muted-foreground uppercase', className)}>{children}</span>;
}

/** A section that stays closed until asked for, with a hint so the reader knows what is inside. */
export function Fold({ title, hint, children, defaultOpen }: { title: ReactNode; hint?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="group rounded-xl border bg-card text-card-foreground shadow-xs transition-shadow duration-200 open:shadow-sm" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-baseline gap-3 rounded-xl px-4 py-3 font-medium transition-colors hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 translate-y-0.5 text-muted-foreground transition-transform group-open:rotate-90" />
        <span>{title}</span>
        {hint && <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">{hint}</span>}
      </summary>
      <div className="motion-reveal flex flex-col gap-3 px-4 pt-1 pb-4">{children}</div>
    </details>
  );
}

/** Page title row: title and description on the left, actions or live status on the right. */
export function PageHeader({ title, description, children, titleClassName }: { title: ReactNode; description?: ReactNode; children?: ReactNode; titleClassName?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className={cn('m-0 text-2xl font-semibold tracking-tight', titleClassName)}>{title}</h1>
        {description && <p className="m-0 max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

/** Who a rule, draft or probe comes from. Each module and row says so with an icon chip, never color alone. */
export type Origin = 'agent' | 'human' | 'system';
const ORIGIN_CHIP: Record<Origin, string> = {
  agent: 'bg-agent-muted text-agent',
  human: 'bg-info-muted text-info',
  system: 'bg-muted text-muted-foreground',
};

/** A section of one origin: an icon chip and title, a count, one line on what it holds, and an action. */
export function Module({
  origin,
  icon: Icon,
  title,
  count,
  description,
  action,
  children,
  id,
}: {
  origin: Origin;
  icon: typeof ChevronRightIcon;
  title: ReactNode;
  count?: number;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <Card id={id} className={cn('scroll-mt-20 gap-3 px-5', origin === 'agent' && 'ring-agent-border/70')}>
      <div className="flex flex-wrap items-start gap-3">
        <span aria-hidden="true" className={cn('grid size-8 shrink-0 place-items-center rounded-lg', ORIGIN_CHIP[origin])}>
          <Icon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="m-0 flex items-center gap-2 text-base font-semibold">
            {title}
            {count !== undefined && <span className="text-sm font-normal text-muted-foreground tabular-nums">{count}</span>}
          </h2>
          {description && <p className="m-0 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </Card>
  );
}

export function OriginChip({ origin, icon: Icon, children }: { origin: Origin; icon: typeof ChevronRightIcon; children: ReactNode }) {
  return (
    <Badge className={cn('gap-1', ORIGIN_CHIP[origin])}>
      <Icon aria-hidden="true" data-icon="inline-start" />
      {children}
    </Badge>
  );
}
