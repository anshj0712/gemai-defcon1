import { useEffect, useRef, useState } from 'react';
import { BellSimpleIcon, XIcon } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { fetchRules, type RuleView } from './api';
import { openProposals, proposalsLabel, toastLine } from './lib/inbox';


const POLL_MS = 5000;
const TOAST_MS = 12_000;
const SEEN_KEY = 'cp_seen_hypotheses';
/** Proposals the person has opened the bell for. Until then the bell keeps asking for attention. */
const ACKED_KEY = 'cp_acked_proposals';
const CALLOUT_MS = 10_000;

function readSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function writeSet(key: string, ids: Iterable<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...ids].slice(-200)));
  } catch {
    // Storage blocked: the bell calms down for this visit only.
  }
}

function readSeen(): Set<string> | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}

function writeSeen(ids: Iterable<string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    // Storage blocked: the bell still counts; toasts may repeat after a reload.
  }
}

const keyOf = (r: RuleView) => `${r.rule_id}@${r.draft!.created_at}`;

const review = () => setTimeout(() => document.getElementById('agent-suspects')?.scrollIntoView({ behavior: 'smooth' }), 50);

/** The toast for a new proposal: visibly the agent's (dashed violet), never a finding. */
function showProposal(r: RuleView): void {
  const line = toastLine(r);
  toast.custom(
    (id) => (
      <div className="flex w-[356px] flex-col gap-2 rounded-lg border border-agent-border bg-popover p-4 text-popover-foreground shadow-[0_12px_32px_-16px_rgb(15_23_42/0.35)]">
        <div className="flex items-center justify-between gap-2">
          <Badge className="bg-agent-muted text-agent">{r.draft?.watch ? 'The agent suspects' : 'The agent suggests a rule'}</Badge>
          <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => toast.dismiss(id)}>
            <XIcon aria-hidden="true" />
          </Button>
        </div>
        <p className="m-0 font-medium">{line.title}</p>
        <p className="m-0 text-[13px] text-muted-foreground">{line.detail}</p>
        <a
          href="#/rules"
          className={cn(buttonVariants({ size: 'sm' }), 'self-start no-underline')}
          onClick={() => {
            toast.dismiss(id);
            review();
          }}
        >
          Review
        </a>
      </div>
    ),
    { duration: TOAST_MS },
  );
}

/**
 * The agent's inbox in the top bar: a bell with the number of open proposals, and a toast when a new one arrives
 * ("The agent suspects ..."). Proposals are hypotheses, not findings; the toast links to the Rules tab to review.
 */
export function AgentInbox() {
  const [open, setOpen] = useState<RuleView[]>([]);
  const seen = useRef<Set<string> | null>(null);
  // Bumped when a new proposal arrives: the bell nudges once and its count pops.
  const [arrivals, setArrivals] = useState(0);
  // Proposals not yet looked at: the bell rings and a note points at it until the bell is opened.
  const [acked, setAcked] = useState<Set<string>>(() => readSet(ACKED_KEY));
  const [callout, setCallout] = useState(false);
  const calloutShown = useRef(false);

  useEffect(() => {
    let stop = false;
    const poll = () =>
      fetchRules().then(
        ({ rules }) => {
          if (stop) return;
          const list = openProposals(rules);
          setOpen(list);
          if (!calloutShown.current && list.some((r) => !readSet(ACKED_KEY).has(keyOf(r)))) {
            calloutShown.current = true;
            setCallout(true);
          }
          if (seen.current === null) seen.current = readSeen() ?? new Set();
          const fresh = list.filter((r) => !seen.current!.has(keyOf(r)));
          if (fresh.length > 0) {
            for (const r of fresh) seen.current.add(keyOf(r));
            writeSeen(seen.current);
            showProposal(fresh[0]!);
            setArrivals((n) => n + 1);
          }
        },
        () => undefined,
      );
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (!callout) return;
    const t = setTimeout(() => setCallout(false), CALLOUT_MS);
    return () => clearTimeout(t);
  }, [callout]);

  const unseen = open.filter((r) => !acked.has(keyOf(r))).length;
  const acknowledge = () => {
    const next = new Set([...acked, ...open.map(keyOf)]);
    setAcked(next);
    writeSet(ACKED_KEY, next);
    setCallout(false);
    review();
  };
  const label = proposalsLabel(open.length);
  return (
    <div className="relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <a href="#/rules" aria-label={label} className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'relative text-topbar-muted hover:bg-topbar-active hover:text-topbar-foreground dark:hover:bg-topbar-active', open.length > 0 && 'text-agent', unseen > 0 && 'text-topbar-foreground')} onClick={acknowledge}>
            {unseen > 0 && <span aria-hidden="true" className="bell-ping pointer-events-none absolute inset-0 rounded-full bg-agent-strong/60" />}
            <BellSimpleIcon key={arrivals} aria-hidden="true" weight={unseen > 0 ? 'fill' : 'regular'} className={cn('relative', unseen > 0 ? 'bell-ring' : arrivals > 0 ? 'motion-nudge' : undefined)} />
            {open.length > 0 && (
              <span key={`${open.length}-${arrivals}`} aria-hidden="true" className="motion-pop absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-agent-strong px-1 text-[10px] leading-none font-semibold text-tier-foreground">
                {open.length}
              </span>
            )}
          </a>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <span role="status" aria-atomic="true" className="sr-only">
        {label}
      </span>
      {callout && unseen > 0 && (
        <div role="note" className="motion-pop absolute top-full right-0 z-50 mt-3 w-64 rounded-lg border border-agent-border bg-popover p-3 text-[13px] text-popover-foreground shadow-[0_12px_32px_-16px_rgb(15_23_42/0.45)]">
          <span aria-hidden="true" className="absolute -top-1.5 right-3 size-3 rotate-45 border-t border-l border-agent-border bg-popover" />
          <b className="font-semibold">
            {unseen} new suggested rule{unseen === 1 ? '' : 's'}
          </b>
          <p className="m-0 mt-0.5 text-muted-foreground">The agent noticed something that makes shoppers leave. Click the bell to look.</p>
          <button type="button" className="absolute top-1.5 right-1.5 text-muted-foreground hover:text-foreground" aria-label="Dismiss" onClick={() => setCallout(false)}>
            <XIcon aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
