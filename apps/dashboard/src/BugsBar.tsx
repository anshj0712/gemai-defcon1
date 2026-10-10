import { useEffect, useState } from 'react';
import { fetchDemoBugs, putDemoBugs, type DemoBugsView } from './api';

/**
 * Which bugs are live in the synthetic demo shop, with a switch for each. The shop follows these within
 * a couple of seconds. Hidden when the API has no demo routes (anything but local mode).
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

  const toggle = (id: string) => {
    const next = view.bugs.includes(id) ? view.bugs.filter((b) => b !== id) : [...view.bugs, id];
    setView({ ...view, bugs: next });
    putDemoBugs(next)
      .then(setView)
      .catch(() => setError(true));
  };

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
          {view.known.map((k) => (
            <label key={k.id}>
              <input type="checkbox" checked={view.bugs.includes(k.id)} onChange={() => toggle(k.id)} />
              <span>
                <b>{k.label}</b> {k.detail}
              </span>
            </label>
          ))}
          {error && <p className="bugsbar-err">Could not reach the API; the last state is shown.</p>}
          <p className="bugsbar-note">Applies to new clicks in the shop within about 2 seconds. A shop tab opened with ?bugs= keeps its own setting.</p>
        </div>
      )}
    </div>
  );
}
