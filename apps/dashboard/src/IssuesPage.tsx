import { useEffect, useRef, useState } from 'react';
import { fetchClusters, type ClusterSummary } from './api';
import { ago, symptomColor, symptomName } from './format';

const REFRESH_MS = 3000;

/**
 * The live issues feed: one card per cluster (one broken thing across every affected session),
 * most recently active first. Refreshes every 3 s; a card flashes when it gains signals.
 */
export function IssuesPage() {
  const [clusters, setClusters] = useState<ClusterSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [bumped, setBumped] = useState<Set<string>>(new Set());
  const [, setTick] = useState(0);
  const lastCounts = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchClusters().then(
        (r) => {
          if (!alive) return;
          const changed = new Set<string>();
          for (const c of r.clusters) {
            const prev = lastCounts.current.get(c.cluster_id);
            if (prev !== undefined && prev !== c.signal_count) changed.add(c.cluster_id);
            lastCounts.current.set(c.cluster_id, c.signal_count);
          }
          setClusters(r.clusters);
          setBumped(changed);
          setUpdatedAt(Date.now());
          setError(null);
        },
        (e: Error) => alive && setError(e.message),
      );
    void load();
    const timer = setInterval(load, REFRESH_MS);
    const clock = setInterval(() => setTick((t) => t + 1), 1000);
    return () => {
      alive = false;
      clearInterval(timer);
      clearInterval(clock);
    };
  }, []);

  if (error && !clusters) return <p className="muted">Could not load issues ({error}). Is the API running? Try <code>pnpm dev</code>.</p>;
  if (!clusters) return <p className="muted">Loading…</p>;

  const sessions = clusters.reduce((n, c) => n + c.session_count, 0);
  const signals = clusters.reduce((n, c) => n + c.signal_count, 0);

  return (
    <>
      <div className="page-head">
        <h1>Issues</h1>
        <span className="live">
          <span className="live-dot" /> Live · updated {updatedAt ? ago(updatedAt) : '-'}
        </span>
      </div>
      <div className="stat-row">
        <div className="stat">
          <b>{clusters.length}</b>
          <span>open issues</span>
        </div>
        <div className="stat">
          <b>{sessions}</b>
          <span>affected sessions</span>
        </div>
        <div className="stat">
          <b>{signals}</b>
          <span>signals grouped</span>
        </div>
      </div>

      {clusters.length === 0 ? (
        <div className="empty">
          <h2>No issues yet</h2>
          <p>
            Shop at <a href="http://localhost:5173/?bugs=dead_button">localhost:5173/?bugs=dead_button</a> and press Apply Coupon 6+ times, or run{' '}
            <code>pnpm sim -- --sessions 50</code> to seed synthetic shoppers.
          </p>
        </div>
      ) : (
        <div className="issues">
          {clusters.map((c) => (
            <a key={c.cluster_id} href={`#/issues/${c.cluster_id}`} className={`issue ${bumped.has(c.cluster_id) ? 'bump' : ''}`}>
              <div className="issue-main">
                <span className={`kind ${c.kind}`}>{c.kind === 'invariant' ? 'Data rule' : 'Element'}</span>
                <h3>{c.title}</h3>
                <div className="chips">
                  {Object.entries(c.detectors)
                    .sort((a, b) => b[1] - a[1])
                    .map(([d, n]) => (
                      <span key={d} className="chip" style={{ borderColor: symptomColor(d), color: symptomColor(d) }}>
                        {symptomName(d)} · {n}
                      </span>
                    ))}
                </div>
                {Object.keys(c.error_signatures).length > 0 && (
                  <p className="muted small">
                    {Object.entries(c.error_signatures)
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 2)
                      .map(([sig]) => sig)
                      .join(' · ')}
                  </p>
                )}
              </div>
              <div className="issue-stats">
                <div>
                  <b>{c.session_count}</b>
                  <span>sessions</span>
                </div>
                <div>
                  <b>{c.signal_count}</b>
                  <span>signals</span>
                </div>
                <div className="when">
                  <span>last seen {ago(c.last_seen)}</span>
                  <span className="muted">{c.route}</span>
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </>
  );
}
