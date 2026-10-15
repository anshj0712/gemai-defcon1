import { useEffect, useRef, useState } from 'react';
import type { FindingSummary } from '@cp/schema';
import { fetchClusters, fetchFindings, type ClusterSummary } from './api';
import { ago, money, symptomColor, symptomName, TIER_NAMES, tierColor } from './format';

/** Scored issues first in finding order (tier, then score); issues the agent has not scored yet after them, newest first. */
export function rankIssues(clusters: readonly ClusterSummary[], findings: readonly FindingSummary[]): { cluster: ClusterSummary; finding: FindingSummary | null }[] {
  const byCluster = new Map(clusters.map((c) => [c.cluster_id, c]));
  const scored = findings.filter((f) => byCluster.has(f.cluster_id)).map((f) => ({ cluster: byCluster.get(f.cluster_id)!, finding: f }));
  const seen = new Set(scored.map((s) => s.cluster.cluster_id));
  const unscored = clusters.filter((c) => !seen.has(c.cluster_id)).map((c) => ({ cluster: c, finding: null }));
  return [...scored, ...unscored];
}

const REFRESH_MS = 3000;

/**
 * The live feed: one card per issue (one broken thing across every affected session), ranked by the
 * agent's findings (tier, then revenue at risk), with issues not yet scored at the end. Refreshes
 * every 3 s; a card flashes when it gains signals.
 */
export function IssuesPage() {
  const [clusters, setClusters] = useState<ClusterSummary[] | null>(null);
  const [findings, setFindings] = useState<FindingSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [bumped, setBumped] = useState<Set<string>>(new Set());
  const [, setTick] = useState(0);
  const lastCounts = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all([fetchClusters(), fetchFindings().catch(() => ({ findings: [] as FindingSummary[] }))]).then(
        ([r, f]) => {
          if (!alive) return;
          const changed = new Set<string>();
          for (const c of r.clusters) {
            const prev = lastCounts.current.get(c.cluster_id);
            if (prev !== undefined && prev !== c.signal_count) changed.add(c.cluster_id);
            lastCounts.current.set(c.cluster_id, c.signal_count);
          }
          setClusters(r.clusters);
          setFindings(f.findings);
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
  const ranked = rankIssues(clusters, findings);
  const estimated = findings.filter((f) => f.revenue.status === 'ok' && f.revenue.currency);
  const currency = estimated[0]?.revenue.currency ?? null;
  const atRisk = estimated.filter((f) => f.revenue.currency === currency).reduce((n, f) => n + f.revenue.revenue_at_risk_minor, 0);

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
        <div className="stat money">
          <b>{estimated.length ? money(atRisk, currency) : '-'}</b>
          <span>revenue at risk (synthetic)</span>
        </div>
      </div>

      {clusters.length === 0 ? (
        <div className="empty">
          <h2>No issues yet</h2>
          <p>
            Shop at <a href="http://localhost:5173/?bugs=dead_button">localhost:5173/?bugs=dead_button</a> and press Apply Coupon 4+ times, or run{' '}
            <code>pnpm sim -- --sessions 50</code> to seed synthetic shoppers.
          </p>
        </div>
      ) : (
        <div className="issues">
          {ranked.map(({ cluster: c, finding: f }) => (
            <a key={c.cluster_id} href={`#/issues/${c.cluster_id}`} className={`issue ${bumped.has(c.cluster_id) ? 'bump' : ''}`}>
              <div className="issue-main">
                {f ? (
                  <span className="tier" style={{ background: tierColor(f.tier) }}>
                    {TIER_NAMES[f.tier] ?? f.tier}
                  </span>
                ) : (
                  <span className="tier pending">scoring…</span>
                )}{' '}
                <span className={`kind ${c.kind}`}>{c.kind === 'invariant' ? 'Data rule' : 'Element'}</span>
                {f?.status === 'suspect' && <span className="suspect">Needs review</span>}
                {c.found_later && c.found_later.sessions > 0 && (
                  <span className="found-later" title="A re-scan with a newer rule found shoppers this hurt before the rule existed">
                    Found later · {c.found_later.sessions} session{c.found_later.sessions === 1 ? '' : 's'}
                  </span>
                )}
                <h3>{f?.title ?? c.title}</h3>
                {f && f.title !== c.title && <p className="muted small detected">{c.title}</p>}
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
                <div className="rar-cell">
                  <b>{f ? (f.revenue.status === 'ok' ? money(f.revenue.revenue_at_risk_minor, f.revenue.currency) : '…') : '-'}</b>
                  <span>at risk</span>
                </div>
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
