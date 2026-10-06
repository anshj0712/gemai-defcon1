import { useEffect, useState } from 'react';
import { fetchSignals, type SignalRowView } from './api';
import { FLAG_COLORS } from './markers';

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Newest signals first; each row opens the session replay at that moment. Refreshes every 5 s. */
export function SignalsPage() {
  const [signals, setSignals] = useState<SignalRowView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchSignals().then(
        (r) => alive && (setSignals(r.signals), setError(null)),
        (e: Error) => alive && setError(e.message),
      );
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (error) return <p className="muted">Could not load signals ({error}). Is the API running? Try <code>pnpm dev</code>.</p>;
  if (!signals) return <p className="muted">Loading…</p>;
  if (signals.length === 0) {
    return (
      <div className="empty">
        <h2>No signals yet</h2>
        <p>
          Open the demo shop at <a href="http://localhost:5173/?bugs=dead_button">localhost:5173/?bugs=dead_button</a>, accept the
          banner, add something to the cart, and click <strong>Apply Coupon</strong> six or more times.
        </p>
      </div>
    );
  }

  return (
    <>
      <h1>Signals</h1>
      <table className="signals">
        <thead>
          <tr>
            <th>Time</th>
            <th>Detector</th>
            <th>Route</th>
            <th>Element</th>
            <th>Session</th>
            <th>Release</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {signals.map((s) => (
            <tr key={s.signal_id}>
              <td>{time(s.event_time)}</td>
              <td>
                <span className="badge" style={{ background: FLAG_COLORS[s.detector] ?? '#ef4444' }}>
                  {s.detector}
                </span>
              </td>
              <td>{s.route}</td>
              <td>
                <code>{s.element_selector ?? '-'}</code>
              </td>
              <td>
                <code>{s.session_id.slice(0, 14)}…</code>
              </td>
              <td>{s.release}</td>
              <td>
                <a className="btn" href={`#/sessions/${s.session_id}?signal=${s.signal_id}`}>
                  Watch replay
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
