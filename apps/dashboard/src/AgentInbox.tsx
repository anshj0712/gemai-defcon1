import { useEffect, useRef, useState } from 'react';
import { fetchRules, type RuleView } from './api';

const POLL_MS = 5000;
const TOAST_MS = 12_000;
const SEEN_KEY = 'cp_seen_hypotheses';

/** Open agent proposals: the churn watcher's hypotheses and rule suggestions for issues, newest first. */
export function openProposals(rules: readonly RuleView[]): RuleView[] {
  return rules.filter((r) => r.draft?.origin === 'agent').sort((a, b) => b.draft!.created_at - a.draft!.created_at);
}

/** What a proposal's toast says: the hypothesis title and its gap, or the suggested rule's title. */
export function toastLine(r: RuleView): { title: string; detail: string } {
  const d = r.draft!;
  const w = d.watch;
  if (!w) return { title: d.rule.title, detail: 'A rule suggested for a recurring issue.' };
  return {
    title: w.title,
    detail: `${Math.round(w.segment.abandonment * 100)}% of ${w.segment.sessions} shoppers left, against ${Math.round(w.baseline.abandonment * 100)}% of the others (synthetic data).`,
  };
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

/**
 * The agent's inbox in the top bar: a bell with the number of open proposals, and a toast when a new one arrives
 * ("The agent suspects ..."). Proposals are hypotheses, not findings; the toast links to the Rules tab to review.
 */
export function AgentInbox() {
  const [open, setOpen] = useState<RuleView[]>([]);
  const [toast, setToast] = useState<RuleView | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let stop = false;
    const poll = () =>
      fetchRules().then(
        ({ rules }) => {
          if (stop) return;
          const list = openProposals(rules);
          setOpen(list);
          if (seen.current === null) seen.current = readSeen() ?? new Set();
          const fresh = list.filter((r) => !seen.current!.has(keyOf(r)));
          if (fresh.length > 0) {
            for (const r of fresh) seen.current.add(keyOf(r));
            writeSeen(seen.current);
            setToast(fresh[0]!);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setToast(null), TOAST_MS);
          }
        },
        () => undefined,
      );
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
      clearTimeout(timer.current);
    };
  }, []);

  const line = toast ? toastLine(toast) : null;
  return (
    <>
      <a className={`inbox${open.length ? ' has' : ''}`} href="#/rules" title={open.length ? `${open.length} open agent proposal${open.length > 1 ? 's' : ''}` : 'No open agent proposals'} aria-label="Agent proposals">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z" />
        </svg>
        {open.length > 0 && <span className="inbox-count">{open.length}</span>}
      </a>
      {toast && line && (
        <div className="agent-toast" role="status">
          <div className="agent-toast-head">
            <span className="hyp-badge">{toast.draft?.watch ? 'The agent suspects' : 'The agent suggests a rule'}</span>
            <button className="agent-toast-close" onClick={() => setToast(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
          <b>{line.title}</b>
          <p>{line.detail}</p>
          <a
            className="btn primary tiny"
            href="#/rules"
            onClick={() => {
              setToast(null);
              setTimeout(() => document.getElementById('agent-suspects')?.scrollIntoView({ behavior: 'smooth' }), 50);
            }}
          >
            Review
          </a>
        </div>
      )}
    </>
  );
}
