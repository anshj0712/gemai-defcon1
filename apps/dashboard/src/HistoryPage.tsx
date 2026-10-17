import { useEffect, useMemo, useState } from 'react';
import { fetchHistory, type HistoryFindingView, type HistoryMomentView, type HistoryView } from './api';
import { money, TIER_NAMES, tierColor } from './format';
import { defaultAsOf, totalAtRisk } from './lib/history';

const WINDOWS = [
  { label: '24 hours', ms: 86_400_000 },
  { label: '7 days', ms: 7 * 86_400_000 },
  { label: '30 days', ms: 30 * 86_400_000 },
] as const;

const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function Row({ f, foundLater }: { f: HistoryFindingView; foundLater: boolean }) {
  return (
    <a href={`#/issues/${f.finding_id}`} className={`hist-row${foundLater ? ' later' : ''}`}>
      <span className="tier sm" style={{ background: tierColor(f.tier) }}>
        {TIER_NAMES[f.tier]?.split(' ')[0] ?? f.tier}
      </span>
      <span className="hist-title">
        {f.title}
        {foundLater && <span className="found-later">Found later</span>}
        <span className="muted small-block">
          {f.affected_sessions} sessions{f.found_later_sessions ? `, ${f.found_later_sessions} found by re-scan` : ''} · first hit {when(f.valid_from)} · recorded {when(f.recorded_from)}
        </span>
      </span>
      <b className="hist-money">{f.revenue_status === 'ok' ? money(f.revenue_at_risk_minor, f.currency) : '…'}</b>
    </a>
  );
}

/**
 * Time travel (bitemporal): pick a moment T and a stretch of shopper activity before it. The left
 * column is what the findings record said at T; the right is what it says now about the same stretch.
 * Issues only on the right are found later: shoppers were already hurt, but the rules at T missed it.
 */
export function HistoryPage() {
  const [now] = useState(() => Date.now());
  const [asOf, setAsOf] = useState<number | null>(null);
  const [windowMs, setWindowMs] = useState<number>(WINDOWS[1].ms);
  const [data, setData] = useState<HistoryView | null>(null);
  const [minT, setMinT] = useState<number>(now - 86_400_000);
  const [error, setError] = useState<string | null>(null);

  // First load: find the moments and the earliest activity, then start just before the latest approval.
  useEffect(() => {
    fetchHistory(now, now - 30 * 86_400_000, now).then(
      (h) => {
        // Start a minute before the first shopper hit anything, so recent activity spans the whole slider.
        const earliest = h.current.length ? Math.min(...h.current.map((f) => f.valid_from)) - 60_000 : now - 3_600_000;
        setMinT(earliest);
        setAsOf(Math.max(earliest, defaultAsOf(h.moments, now)));
      },
      (e: Error) => setError(e.message),
    );
  }, [now]);

  useEffect(() => {
    if (asOf === null) return;
    let alive = true;
    const t = setTimeout(() => {
      fetchHistory(asOf, asOf - windowMs, asOf).then(
        (h) => alive && (setData(h), setError(null)),
        (e: Error) => alive && setError(e.message),
      );
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [asOf, windowMs]);

  const later = useMemo(() => new Set(data?.found_later ?? []), [data]);
  if (error && !data) return <p className="muted">Could not load the history ({error}). Is the API running? Try <code>pnpm dev</code>.</p>;
  if (asOf === null || !data) return <p className="muted">Loading…</p>;

  const then = totalAtRisk(data.then);
  const current = totalAtRisk(data.current);
  const laterList = data.current.filter((f) => later.has(f.finding_id));
  const laterMoney = totalAtRisk(laterList);
  const span = Math.max(1, now - minT);

  return (
    <>
      <div className="page-head">
        <h1>Time travel</h1>
        <span className="muted small">Synthetic data: demo sessions only</span>
      </div>
      <p className="muted lead">
        What did we know at a moment in the past, compared with what we know now about the same stretch of shopper activity? Issues that appear only today were already hurting shoppers; the rules at the time did not flag them.
      </p>

      <div className="panel timeline">
        <div className="timeline-head">
          <span>
            As of <b>{when(asOf)}</b>
          </span>
          <label className="muted">
            shopper activity in the{' '}
            <select value={windowMs} onChange={(e) => setWindowMs(Number(e.target.value))}>
              {WINDOWS.map((w) => (
                <option key={w.ms} value={w.ms}>
                  {w.label}
                </option>
              ))}
            </select>{' '}
            before it
          </label>
        </div>
        <div className="slider-wrap">
          <input type="range" min={minT} max={now} step={1000} value={asOf} onChange={(e) => setAsOf(Number(e.target.value))} aria-label="As of" />
          {data.moments.map((m) => (
            <span key={`${m.kind}-${m.at}`} className={`tick ${m.kind}`} style={{ left: `${((m.at - minT) / span) * 100}%` }} title={`${m.label} · ${when(m.at)}`} />
          ))}
        </div>
        <div className="row-actions">
          {data.moments.map((m) => (
            <button key={`jump-${m.kind}-${m.at}`} className="btn tiny" onClick={() => setAsOf(m.kind === 'rule_approved' ? m.at - 1000 : m.at + 1000)}>
              {m.kind === 'rule_approved' ? 'Just before: ' : 'Just after: '}
              {m.label}
            </button>
          ))}
          <button className="btn tiny" onClick={() => setAsOf(now)}>
            Now
          </button>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat">
          <b>{data.then.length}</b>
          <span>
            issues known at {when(asOf)} · {money(then.minor, then.currency)} at risk
          </span>
        </div>
        <div className="stat">
          <b>{data.current.length}</b>
          <span>issues known now, same stretch · {money(current.minor, current.currency)} at risk</span>
        </div>
        <div className={`stat${laterList.length ? ' later' : ''}`}>
          <b>{laterList.length}</b>
          <span>found later · {money(laterMoney.minor, laterMoney.currency)} at risk (synthetic)</span>
        </div>
      </div>

      <div className="hist-grid">
        <div className="panel">
          <h3>What we knew then</h3>
          {data.then.length === 0 ? <p className="muted">No issues were on record at that moment for this stretch.</p> : data.then.map((f) => <Row key={f.finding_id} f={f} foundLater={false} />)}
        </div>
        <div className="panel">
          <h3>What we know now about the same stretch</h3>
          {data.current.length === 0 ? <p className="muted">No issues on record for this stretch.</p> : data.current.map((f) => <Row key={f.finding_id} f={f} foundLater={later.has(f.finding_id)} />)}
        </div>
      </div>
      <p className="muted small">
        Both columns come from the versioned findings record (valid time and transaction time), not the live feed. All sessions and numbers are synthetic.
      </p>
    </>
  );
}
