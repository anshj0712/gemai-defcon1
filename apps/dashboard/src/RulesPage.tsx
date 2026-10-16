import { useCallback, useEffect, useState } from 'react';
import type { DryRun, RescanStatus, RevenueAtRisk } from '@cp/schema';
import { ApiError, approveRule, draftRule, fetchClusters, fetchRules, rejectRule, rescanRule, type BuiltinRuleView, type ClusterSummary, type RuleView } from './api';
import { ago, formulaLine, money, pct, time } from './format';
import { ProbesPanel } from './ProbesPanel';

/** Example sentences. The first one finds the demo shop's silent quantity-price bug (synthetic data). */
export const EXAMPLES = [
  'No pair of shoes costs more than ₹17,000, so the bag subtotal must never be more than ₹17,000 times the number of pairs.',
  'The discount must never be more than 10% of the bag.',
  'The cart total must equal the line items minus the discount.',
  // A speed rule over a request probe (every network call is one, automatically).
  'Payment authorisation (req_post_api_payment_authorize_ms) must answer within 3 seconds.',
];

const REFRESH_MS = 2000;

/** "Model gemini-3.8-flash" or the offline stand-in, said plainly. */
function authorLine(a: { model: string; offline: boolean }): string {
  return a.offline ? 'Drafted by the offline stand-in (a template parser, not Gemini). Set GOOGLE_API_KEY for Gemini.' : `Drafted by ${a.model}`;
}

/** Who worded an agent suggestion: Gemini, or the offline stand-in, said plainly. */
function suggesterLine(s: { model: string; offline: boolean }): string {
  return s.offline ? 'Suggested by the offline stand-in (templated, not Gemini). Set GOOGLE_API_KEY for Gemini.' : `Suggested by ${s.model}`;
}

const LOST_HOW = 'Affected sessions with a cart × average cart × (their abandonment − baseline abandonment), over the sessions the dry run flags.';

/**
 * Revenue already lost to the pattern: the revenue-at-risk formula over the dry run's hits. Prominent on an
 * agent suggestion (it is why the suggestion matters), one compact line on a merchant's own draft.
 */
function RevenueLost({ r, prominent, at }: { r: RevenueAtRisk; prominent: boolean; at: number }) {
  const ok = r.status === 'ok';
  // Computed once, when the draft and its dry run were made; it does not move with later sessions.
  const asOf = <span className="muted small-inline">as of {time(at)}</span>;
  if (!prominent) {
    return (
      <p className="small-p" title={ok ? `${LOST_HOW} ${formulaLine(r)}` : undefined}>
        Estimated revenue lost to date: {ok ? <b className="bad">{money(r.revenue_at_risk_minor, r.currency)}</b> : <span className="muted">{r.note ?? 'not enough data yet'}</span>} {asOf} <span className="synthetic-note">synthetic data</span>
      </p>
    );
  }
  return (
    <div className={`lost${ok ? '' : ' pending'}`}>
      <p className="lost-line">
        Estimated revenue lost to date: {ok ? <b>{money(r.revenue_at_risk_minor, r.currency)}</b> : <span className="muted">not enough data yet</span>} {asOf} <span className="synthetic-note">synthetic data</span>
      </p>
      {ok ? (
        <p className="small-p muted" title={formulaLine(r)}>
          {LOST_HOW} {formulaLine(r)}
        </p>
      ) : (
        r.note && <p className="small-p muted">{r.note}</p>
      )}
    </div>
  );
}

/**
 * The two sides of a flagged snapshot. Probe values carry no unit, so whole numbers under 1,000 on both
 * sides are shown as counts (for example 1 pair against 2 lines): no amount in the shop is below ₹10.
 */
function sideText(left: number | null, right: number | null, currency: string | null): string {
  const small = (v: number | null) => v === null || (Number.isInteger(v) && Math.abs(v) < 1000);
  if (small(left) && small(right)) return `${left ?? '?'} against ${right ?? '?'}`;
  return `${money(left, currency)} against ${money(right, currency)}`;
}

function DryRunBlock({ d }: { d: DryRun }) {
  return (
    <>
      <p className="small-p">
        Checked <b>{d.sessions_scanned}</b> recent session{d.sessions_scanned === 1 ? '' : 's'}{d.truncated ? ' (the newest; more exist)' : ''}. The rule applies to <b>{d.sessions_applicable}</b> and would flag{' '}
        <b className={d.sessions_hit ? 'bad' : ''}>{d.sessions_hit}</b>
        {d.hit_rate !== null && <> ({pct(d.hit_rate)} of those it applies to)</>}. {d.hits_in_issues > 0 ? `${d.hits_in_issues} of them are already in an issue.` : 'None of them is in an issue yet.'}
      </p>
      {d.samples.length > 0 && (
        <table className="signals compact">
          <tbody>
            {d.samples.map((s) => (
              <tr key={s.session_id}>
                <td>{time(s.event_time)}</td>
                <td>{s.route}</td>
                <td title="Left side of the rule against its right side">
                  {sideText(s.left, s.right, s.currency)}
                </td>
                <td>{s.in_issue ? <span className="muted">in an issue</span> : <span className="found-later">new</span>}</td>
                <td>
                  <a className="btn tiny" href={`#/sessions/${s.session_id}`}>
                    Watch replay
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function RescanBlock({ s, issue, onRescan, busy }: { s: RescanStatus; issue: ClusterSummary | null; onRescan: () => void; busy: boolean }) {
  const pctDone = s.sessions_total > 0 ? Math.min(1, s.sessions_scanned / s.sessions_total) : s.status === 'running' ? 0 : 1;
  const days = Math.round((s.window.to - s.window.from) / 86_400_000);
  return (
    <div className="rescan">
      <div className="rescan-head">
        <b>Re-scan of the last {days} days</b>
        <span className={`rescan-state ${s.status}`}>{s.status === 'running' ? 'running' : s.status === 'done' ? 'done' : s.status}</span>
      </div>
      <div className="bar">
        <span style={{ width: `${pctDone * 100}%`, background: s.status === 'failed' || s.status === 'interrupted' ? '#dc2626' : '#7c3aed' }} />
      </div>
      <p className="small-p">
        {s.sessions_scanned} of {s.sessions_total || '…'} sessions read{s.truncated ? ' (capped at the newest)' : ''} · <b>{s.sessions_hit}</b> session{s.sessions_hit === 1 ? '' : 's'} hit · {s.signals_written} signal
        {s.signals_written === 1 ? '' : 's'} written with their original times
        {s.sessions_failed > 0 && <> · {s.sessions_failed} unreadable</>}
        {s.finished_at && <> · finished {ago(s.finished_at)}</>}
      </p>
      {s.error && <p className="notice">{s.error}</p>}
      <div className="row-actions">
        {issue && (
          <a className="btn primary" href={`#/issues/${issue.cluster_id}`}>
            Open the issue ({issue.session_count} sessions)
          </a>
        )}
        {s.status !== 'running' && (
          <button className="btn" disabled={busy} onClick={onRescan}>
            Re-scan again
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A pending draft: the merchant's own, or one the agent suggested for a recurring issue. Both have the same
 * dry run and the same two actions; approving is the only thing that makes either live and starts a re-scan.
 */
function DraftCard({ r, busy, error, onApprove, onDiscard }: { r: RuleView; busy: string | null; error: Error | null; onApprove: () => void; onDiscard: () => void }) {
  const d = r.draft!;
  const agent = d.origin === 'agent';
  const suggester = d.suggester ?? null;
  const lost = d.revenue_lost ?? null;
  return (
    <div className={`panel rule-card draft${agent ? ' agent' : ''}`}>
      <div className="finding-head">
        <span className="kind invariant">Draft · v{d.rule.version}</span>
        {agent && <span className="agent-badge">Suggested by the agent</span>}
        <span className="muted small-inline">{authorLine(d.author)}</span>
      </div>
      <h3 className="rule-title">{d.rule.title}</h3>
      <p className="sentence">“{d.sentence}”</p>
      {agent && (
        <>
          {suggester?.explanation && (
            <p className="small-p">
              <b>Why:</b> {suggester.explanation}
            </p>
          )}
          {suggester && suggester.assumptions.length > 0 && (
            <ul className="assumptions">
              {suggester.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
          <p className="small-p muted">
            {suggester ? suggesterLine(suggester) : 'Suggested by the agent'}
            {d.cluster_id && (
              <>
                {' · '}
                <a href={`#/issues/${d.cluster_id}`}>Open the issue that prompted it</a>
              </>
            )}
          </p>
          {lost && <RevenueLost r={lost} prominent at={d.created_at} />}
        </>
      )}
      <p className="rule-text">
        <code>{r.text.draft}</code> <span className="muted small">(money in minor units)</span>
      </p>
      {d.author.explanation && <p className="small-p">{d.author.explanation}</p>}
      {d.author.assumptions.length > 0 && (
        <ul className="assumptions">
          {d.author.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
      <h4>Dry run (nothing written)</h4>
      {d.dry_run ? <DryRunBlock d={d.dry_run} /> : <p className="muted">No dry run.</p>}
      {!agent && lost && <RevenueLost r={lost} prominent={false} at={d.created_at} />}
      <div className="row-actions">
        <button className="btn primary" disabled={busy !== null} onClick={onApprove}>
          {busy === `approve-${r.rule_id}` ? 'Approving…' : 'Approve and re-scan the last 30 days'}
        </button>
        <button className="btn" disabled={busy !== null} onClick={onDiscard}>
          Discard
        </button>
      </div>
      {error && (
        <div className="notice">
          <b>That did not work.</b> {error.message}
        </div>
      )}
    </div>
  );
}

/**
 * Rules in plain English (Phase 4). A merchant describes what must always hold; Gemini drafts an
 * invariant over the store's probes; a dry run shows what it would flag; approving it runs it on live
 * traffic and re-scans the last 30 days, so shoppers it already hurt show up as found later.
 */
export function RulesPage() {
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [builtin, setBuiltin] = useState<BuiltinRuleView[]>([]);
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const [sentence, setSentence] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  /** The action that failed, so a draft card shows its own error instead of the composer. */
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      Promise.all([fetchRules(), fetchClusters().catch(() => ({ clusters: [] as ClusterSummary[] }))]).then(
        ([r, c]) => {
          setRules(r.rules);
          setBuiltin(r.builtin);
          setClusters(c.clusters);
          setLoadError(null);
        },
        (e: Error) => setLoadError(e.message),
      ),
    [],
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    setErrorKey(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setErrorKey(key);
    } finally {
      setBusy(null);
    }
  };

  const issueFor = (ruleId: string) => clusters.find((c) => c.kind === 'invariant' && c.anchor === ruleId) ?? null;

  if (loadError && !rules) return <p className="muted">Could not load rules ({loadError}). Is the API running? Try <code>pnpm dev</code>.</p>;
  if (!rules) return <p className="muted">Loading…</p>;

  const drafts = rules.filter((r) => r.draft);
  // Drafts stored before origin existed have none: they are the merchant's.
  const suggested = drafts.filter((r) => r.draft!.origin === 'agent');
  const own = drafts.filter((r) => r.draft!.origin !== 'agent');
  const active = rules.filter((r) => r.active);
  const card = (r: RuleView) => (
    <DraftCard
      key={`draft-${r.rule_id}`}
      r={r}
      busy={busy}
      error={errorKey === `approve-${r.rule_id}` || errorKey === `reject-${r.rule_id}` ? error : null}
      onApprove={() => void act(`approve-${r.rule_id}`, () => approveRule(r.rule_id, r.draft!.rule.version))}
      onDiscard={() => void act(`reject-${r.rule_id}`, () => rejectRule(r.rule_id))}
    />
  );

  return (
    <>
      <div className="page-head">
        <h1>Rules</h1>
        <span className="muted small">Synthetic data: demo sessions only</span>
      </div>
      <p className="muted lead">
        Describe something that must always be true in your store. Gemini turns it into a check over the numbers your pages report (probes), a dry run shows what it would flag, and approving it runs it on live traffic and
        re-scans the last 30 days. Shoppers it already hurt show up as <span className="found-later">found later</span>.
      </p>

      <div className="panel composer">
        <textarea
          value={sentence}
          onChange={(e) => setSentence(e.target.value)}
          placeholder="For example: the discount must never be more than 10% of the bag."
          rows={3}
          maxLength={500}
          disabled={busy === 'draft'}
        />
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="example" onClick={() => setSentence(ex)} disabled={busy === 'draft'}>
              {ex}
            </button>
          ))}
        </div>
        <div className="row-actions">
          <button className="btn primary" disabled={busy !== null || sentence.trim().length < 8} onClick={() => void act('draft', () => draftRule(sentence))}>
            {busy === 'draft' ? 'Drafting… (rule author + dry run)' : 'Draft rule'}
          </button>
        </div>
        {error && !drafts.some((r) => errorKey === `approve-${r.rule_id}` || errorKey === `reject-${r.rule_id}`) && (
          <div className="notice">
            <b>{error instanceof ApiError && error.code === 'not_understood' ? 'The rule author could not express this as a rule.' : 'That did not work.'}</b> {error.message}
            {error instanceof ApiError && error.author && <p className="small-p muted">{authorLine(error.author)}</p>}
          </div>
        )}
      </div>

      {own.map(card)}

      <ProbesPanel onChanged={() => void load()} />

      <section className="suggested">
        <div className="suggested-head">
          <h2 className="section-title">Suggested by the agent</h2>
          <span className="muted small-inline">You approve these the same way; nothing runs until you do.</span>
        </div>
        {suggested.length === 0 ? (
          <p className="muted small-p">No suggestions yet. The agent suggests a rule when a recurring issue's recorded numbers show a defect a rule could catch.</p>
        ) : (
          suggested.map(card)
        )}
      </section>

      <h2 className="section-title">Your rules</h2>
      {active.length === 0 ? (
        <p className="muted">No approved rules yet. Draft one above.</p>
      ) : (
        active.map((r) => {
          const a = r.active!;
          return (
            <div key={`active-${r.rule_id}`} className="panel rule-card">
              <div className="finding-head">
                <span className="kind invariant">Live · v{a.rule.version}</span>
                <span className="muted small-inline">
                  approved {ago(a.approved_at)} by {a.approved_by}
                  {a.author ? ` · ${a.author.offline ? 'offline stand-in' : a.author.model}` : ''}
                </span>
              </div>
              <h3 className="rule-title">{r.title}</h3>
              <p className="sentence">“{a.sentence}”</p>
              <p className="rule-text">
                <code>{r.text.active}</code>
              </p>
              {r.rescan && <RescanBlock s={r.rescan} issue={issueFor(r.rule_id)} busy={busy !== null} onRescan={() => void act(`rescan-${r.rule_id}`, () => rescanRule(r.rule_id))} />}
            </div>
          );
        })
      )}

      <h2 className="section-title">Built-in rules</h2>
      {builtin.map((b) => (
        <div key={b.rule_id} className="panel rule-card builtin">
          <div className="finding-head">
            <span className="kind">Built-in · v{b.version}</span>
          </div>
          <h3 className="rule-title">{b.title}</h3>
          <p className="rule-text">
            <code>{b.text}</code>
          </p>
        </div>
      ))}
      <p className="muted small">All sessions and numbers are synthetic.</p>
    </>
  );
}
