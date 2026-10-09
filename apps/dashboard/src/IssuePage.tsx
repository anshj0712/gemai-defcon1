import { useEffect, useState } from 'react';
import type { Cluster, Finding } from '@cp/schema';
import { fetchCluster, fetchFinding, type FindingVersionView } from './api';
import { FindingPanel } from './FindingPanel';
import { ago, symptomColor, symptomName, time } from './format';

/**
 * One issue: its finding (revenue at risk, tier, the agents' analysis and visual check, each claim
 * linked to its evidence) on top, then its symptoms, errors, and affected sessions, each a click away
 * from its replay.
 */
export function IssuePage({ clusterId }: { clusterId: string }) {
  const [cluster, setCluster] = useState<Cluster | null>(null);
  const [finding, setFinding] = useState<{ finding: Finding; versions: FindingVersionView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all([fetchCluster(clusterId), fetchFinding(clusterId)]).then(
        ([c, f]) => alive && (setCluster(c.cluster), setFinding(f), setError(null)),
        (e: Error) => alive && setError(e.message),
      );
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [clusterId]);

  if (error && !cluster) return <p className="muted">Could not load this issue ({error}).</p>;
  if (!cluster) return <p className="muted">Loading issue…</p>;

  const total = Object.values(cluster.detectors).reduce((a, b) => a + b, 0) || 1;
  const latest = cluster.evidence[0];

  return (
    <>
      <p>
        <a href="#/">← Issues</a>
      </p>
      {finding ? (
        <FindingPanel finding={finding.finding} versions={finding.versions} />
      ) : (
        <p className="notice">The agent service has not scored this issue yet. It does within a few seconds of the issue opening when <code>pnpm dev</code> is running.</p>
      )}
      <h2 className="section-title">Issue details</h2>
      <span className={`kind ${cluster.kind}`}>{cluster.kind === 'invariant' ? 'Data rule' : 'Element'}</span>
      <h3 className="issue-subtitle">{cluster.title}</h3>
      <p className="muted">
        <code>{cluster.anchor}</code> · {cluster.route} · first seen {time(cluster.first_seen)} · last seen {ago(cluster.last_seen)}
      </p>

      <div className="stat-row">
        <div className="stat">
          <b>{cluster.session_count}</b>
          <span>affected sessions</span>
        </div>
        <div className="stat">
          <b>{cluster.signal_count}</b>
          <span>signals</span>
        </div>
        <div className="stat">
          <b>{Object.keys(cluster.releases).length}</b>
          <span>release{Object.keys(cluster.releases).length === 1 ? '' : 's'}: {Object.keys(cluster.releases).join(', ')}</span>
        </div>
        {latest && (
          <a className="btn primary stat-action" href={`#/sessions/${latest.session_id}?signal=${latest.signal_id}`}>
            ▶ Watch the latest occurrence
          </a>
        )}
      </div>

      <div className="detail-grid">
        <section className="panel">
          <h3>Symptoms</h3>
          {Object.entries(cluster.detectors)
            .sort((a, b) => b[1] - a[1])
            .map(([d, n]) => (
              <div key={d} className="bar-row">
                <span>{symptomName(d)}</span>
                <span className="bar">
                  <span style={{ width: `${(n / total) * 100}%`, background: symptomColor(d) }} />
                </span>
                <b>{n}</b>
              </div>
            ))}
          {Object.keys(cluster.error_signatures).length > 0 && (
            <>
              <h3>Errors seen just before</h3>
              <ul className="errors">
                {Object.entries(cluster.error_signatures)
                  .sort((a, b) => b[1] - a[1])
                  .map(([sig, n]) => (
                    <li key={sig}>
                      <code>{sig}</code> <span className="muted">× {n}</span>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </section>

        <section className="panel">
          <h3>Latest occurrences</h3>
          <table className="signals compact">
            <tbody>
              {cluster.evidence.map((e) => (
                <tr key={e.signal_id}>
                  <td>{time(e.event_time)}</td>
                  <td>
                    <span className="chip" style={{ borderColor: symptomColor(e.detector), color: symptomColor(e.detector) }}>
                      {symptomName(e.detector)}
                    </span>
                  </td>
                  <td>
                    <code>{e.session_id.slice(0, 14)}…</code>
                  </td>
                  <td>
                    <a className="btn" href={`#/sessions/${e.session_id}?signal=${e.signal_id}`}>
                      Watch replay
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>All affected sessions ({cluster.session_count})</h3>
          <div className="session-list">
            {cluster.sessions.map((s) => (
              <a key={s} href={`#/sessions/${s}`}>
                <code>{s}</code>
              </a>
            ))}
          </div>
        </section>
      </div>
      <p className="muted small">All sessions and numbers are synthetic.</p>
    </>
  );
}
