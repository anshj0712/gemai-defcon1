import { useEffect, useState } from 'react';
import { fetchDemoBugs, putDemoBugs, type DemoBugsView } from './api';

/** Who catches each bug, in the words the switch panel uses. */
const CAUGHT: Record<string, string> = {
  detector: 'Detector',
  builtin_rule: 'Built-in rule',
  merchant_rule: 'Your rule',
  agent_rule: 'Agent rule',
  agent: 'Agent finds it',
};

/** The switches grouped by churn reason, in the order the API lists the bugs. */
export function groupBugs(view: DemoBugsView): { reason: string; label: string; bugs: DemoBugsView['known'] }[] {
  const groups = new Map<string, DemoBugsView['known']>();
  for (const k of view.known) {
    const key = k.reason ?? 'other';
    groups.set(key, [...(groups.get(key) ?? []), k]);
  }
  return [...groups.entries()].map(([reason, bugs]) => ({ reason, label: view.reasons?.[reason] ?? 'Other', bugs }));
}

/**
 * Which bugs are live in the synthetic demo shop, with a switch for each, grouped by the churn reason they
 * stand for. The shop follows these within a couple of seconds. Hidden when the API has no demo routes.
 */
export function BugsBar() {
  const [view, setView] = useState<DemoBugsView | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = () =>
      fetchDemoBugs()
        .then((v) => !stop && (setView(v), setError(false)))
        .catch(() => !stop && setError(true));
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  if (!view) return null;

  const save = (next: string[]) => {
    setView({ ...view, bugs: next });
    putDemoBugs(next)
      .then(setView)
      .catch(() => setError(true));
  };
  const toggle = (id: string) => save(view.bugs.includes(id) ? view.bugs.filter((b) => b !== id) : [...view.bugs, id]);

  const live = view.known.filter((k) => view.bugs.includes(k.id));
  return (
    <div className={`bugsbar ${live.length ? 'live' : 'idle'}`}>
      <button type="button" className="bugsbar-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="bugsbar-dot" />
        {live.length ? `${live.length} bug${live.length > 1 ? 's' : ''} live in the shop: ${live.map((b) => b.label).join(', ')}` : 'No bugs live in the shop'}
        <span className="bugsbar-more">{open ? 'Hide' : 'Switch bugs'}</span>
      </button>
      {open && (
        <div className="bugsbar-body">
          <div className="bugsbar-actions">
            <button type="button" className="btn tiny" onClick={() => save(view.known.map((k) => k.id))}>
              All on
            </button>
            <button type="button" className="btn tiny" onClick={() => save([])}>
              All off
            </button>
          </div>
          <div className="bugsbar-groups">
            {groupBugs(view).map((g) => (
              <fieldset key={g.reason} className="bugsbar-group">
                <legend>{g.label}</legend>
                {g.bugs.map((k) => (
                  <label key={k.id}>
                    <input type="checkbox" checked={view.bugs.includes(k.id)} onChange={() => toggle(k.id)} />
                    <span>
                      <b>{k.label}</b> {k.detail}
                      {k.caught && (
                        <span className={`caught ${k.caught}`} title={k.caught_detail}>
                          {CAUGHT[k.caught] ?? k.caught}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
          {error && <p className="bugsbar-err">Could not reach the API; the last state is shown.</p>}
          <p className="bugsbar-note">
            Applies to new clicks in the shop within about 2 seconds. A shop tab opened with ?bugs= keeps its own setting. Not covered: competitor offers and discount-only shoppers are not page defects. All data is synthetic.
          </p>
        </div>
      )}
    </div>
  );
}
