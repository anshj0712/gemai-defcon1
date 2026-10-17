import type { ReactNode } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { symptomColor, symptomName, TIER_NAMES } from '../format';

/** Small building blocks shared by the pages. Colors are tokens (see index.css), and every color sits next to text. */

const TIER_CLASS: Record<string, string> = { P0: 'bg-tier-p0', P1: 'bg-tier-p1', P2: 'bg-tier-p2', P3: 'bg-tier-p3' };

/** "P0 · blocker" on the tier's fill; `short` shows just "P0". */
export function TierBadge({ tier, short, className }: { tier: string; short?: boolean; className?: string }) {
  return <Badge className={cn('font-semibold text-tier-foreground', TIER_CLASS[tier] ?? 'bg-tier-p3', className)}>{short ? tier : (TIER_NAMES[tier] ?? tier)}</Badge>;
}

export function PendingTierBadge() {
  return (
    <Badge variant="secondary" className="text-muted-foreground">
      Scoring…
    </Badge>
  );
}

/** Element issues (a control on a page) or data-rule issues (a number that broke a rule). */
export function KindBadge({ kind }: { kind: string }) {
  return kind === 'invariant' ? (
    <Badge variant="outline" className="border-info-border bg-info-muted text-info">
      Data rule
    </Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">
      Element
    </Badge>
  );
}

/** A symptom with its count. The dot uses the same color as the replay timeline's flag for that detector. */
export function SymptomChip({ detector, count }: { detector: string; count?: number }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-medium text-foreground">
      <span aria-hidden="true" className="size-2 rounded-full" style={{ background: symptomColor(detector) }} />
      {symptomName(detector)}
      {count !== undefined && <span className="text-muted-foreground tabular-nums">{count}</span>}
    </Badge>
  );
}

/** AGENTS rule 10: demo numbers say they are synthetic. */
export function SyntheticNote({ children = 'Synthetic data', className }: { children?: ReactNode; className?: string }) {
  return (
    <Badge variant="outline" className={cn('border-synthetic-border bg-synthetic-muted font-medium text-synthetic', className)}>
      {children}
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
    <details className="group rounded-xl border bg-card text-card-foreground shadow-xs" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-baseline gap-3 rounded-xl px-4 py-3 font-medium transition-colors hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 translate-y-0.5 text-muted-foreground transition-transform group-open:rotate-90" />
        <span>{title}</span>
        {hint && <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">{hint}</span>}
      </summary>
      <div className="flex flex-col gap-3 px-4 pt-1 pb-4">{children}</div>
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
