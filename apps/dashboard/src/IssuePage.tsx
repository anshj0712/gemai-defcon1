import { useEffect, useState } from 'react';
import type { Cluster, Finding } from '@cp/schema';
import { fetchCluster, fetchFinding, type FindingVersionView } from './api';
import { Fold, FindingFolds, FindingSummary } from './FindingPanel';
import { ago, symptomColor, symptomName, time } from './format';

/**
 * One issue. At a glance: what it costs, what shoppers hit, the proof, and how to recreate it (compact
 * cards that open for detail). Behind that, closed by default: how it was scored, the evidence the
 * agents saw, the symptoms and errors, the occurrences and affected sessions, and the audit trail.
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
        <FindingSummary finding={finding.finding} cluster={cluster} />
      ) : (
        <>
          <span className={`kind ${cluster.kind}`}>{cluster.kind === 'invariant' ? 'Data rule' : 'Element'}</span>
          <h1 className="issue-title">{cluster.title}</h1>
          <p className="muted">
            <code>{cluster.anchor}</code> · {cluster.route} · {cluster.session_count} sessions · last seen {ago(cluster.last_seen)}
          </p>
          <p className="notice">The agent service has not scored this issue yet. It does within a few seconds of the issue opening when <code>pnpm dev</code> is running.</p>
          {latest && (
            <a className="btn primary" href={`#/sessions/${latest.session_id}?signal=${latest.signal_id}`}>
              ▶ Watch the latest occurrence
            </a>
          )}
        </>
      )}

      <div className="folds">
        {finding && <FindingFolds finding={finding.finding} versions={finding.versions} />}
        <Fold title="Symptoms and errors" hint={`${Object.keys(cluster.detectors).length} kinds · ${cluster.signal_count} signals · ${Object.keys(cluster.releases).length} release${Object.keys(cluster.releases).length === 1 ? '' : 's'}: ${Object.keys(cluster.releases).join(', ')}`}>
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
        </Fold>
        <Fold title="Occurrences and affected sessions" hint={`last seen ${ago(cluster.last_seen)} · ${cluster.session_count} sessions`}>
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
          </Fold>
      </div>
      <p className="muted small">All sessions and numbers are synthetic.</p>
    </>
  );
}
