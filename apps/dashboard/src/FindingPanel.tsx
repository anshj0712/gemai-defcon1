import { useState, type ReactNode } from 'react';
import type { Claim, Cluster, EvidenceItem, Finding } from '@cp/schema';
import { screenshotUrl, type FindingVersionView } from './api';
import { CATEGORY_NAMES, formulaLine, money, pct, plain, TIER_NAMES, tierColor, time } from './format';

const OFFLINE_MODEL = 'offline-stand-in';

const VERDICTS: Record<string, { label: string; color: string }> = {
  confirmed: { label: 'Visually confirmed', color: '#16a34a' },
  not_confirmed: { label: 'Not visible on screen', color: '#dc2626' },
  unclear: { label: 'Unclear on screen', color: '#ca8a04' },
  not_checked: { label: 'Not visually checked', color: '#64748b' },
};

/** Where an evidence item leads: signals and the screenshot open the replay at their moment. */
function evidenceHref(e: EvidenceItem | undefined): string | null {
  return e?.session_id ? `#/sessions/${e.session_id}${e.signal_id ? `?signal=${e.signal_id}` : ''}` : null;
}

function EvidenceChips({ ids, byId }: { ids: readonly string[]; byId: Map<string, EvidenceItem> }) {
  if (ids.length === 0) return null;
  return (
    <span className="ev-chips">
      {ids.map((id) => {
        const e = byId.get(id);
        const href = evidenceHref(e);
        const title = e ? e.text : 'unknown evidence';
        return href ? (
          <a key={id} className="ev-chip link" href={href} title={`${title} (opens the replay)`}>
            {id} ▶
          </a>
        ) : (
          <span key={id} className="ev-chip" title={title}>
            {id}
          </span>
        );
      })}
    </span>
  );
}

function ClaimText({ claim, byId }: { claim: Claim; byId: Map<string, EvidenceItem> }) {
  return (
    <p className="claim">
      {plain(claim.text)} <EvidenceChips ids={claim.evidence_ids} byId={byId} />
    </p>
  );
}

/** A summary card: the gist at a glance, the full detail one click away. An open card takes the whole row. */
function SummaryCard({ title, badge, open, onToggle, summary, detail }: { title: string; badge?: ReactNode; open: boolean; onToggle: () => void; summary: ReactNode; detail: ReactNode }) {
  return (
    <section className={`scard${open ? ' open' : ''}`}>
      <button type="button" className="scard-head" onClick={onToggle} aria-expanded={open}>
        <span className="scard-title">{title}</span>
        {badge}
        <span className="scard-toggle">{open ? 'Less' : 'Details'}</span>
      </button>
      {open ? <div className="scard-detail">{detail}</div> : <div className="scard-body">{summary}</div>}
    </section>
  );
}

/** A section that stays closed until asked for, with a count so the reader knows what is inside. */
export function Fold({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <details className="fold">
      <summary>
        <span>{title}</span>
        {hint && <span className="fold-hint">{hint}</span>}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

/**
 * The top of an issue page: what it costs, what happened, the proof, and how to see it yourself. Each
 * piece is a compact card that opens for the full story (claims linked to their evidence).
 */
const JUROR_NAMES: Record<string, { name: string; asks: string }> = {
  evidence_auditor: { name: 'Fact checker', asks: 'Does every claim rest on the evidence it cites?' },
  skeptic: { name: 'False-alarm hunter', asks: 'Could this just be normal shopper behaviour?' },
  impact_analyst: { name: 'Money and priority', asks: 'Do the numbers and the priority fit the evidence?' },
  repro_reviewer: { name: 'Steps check', asks: 'Could an engineer reproduce and fix it from this?' },
};

/** The jury's verdict: four independent scores, the bar they had to clear, and the judge's ruling in words. */
function VerdictCard({ v, byId }: { v: NonNullable<Finding['verdict']>; byId: Map<string, EvidenceItem> }) {
  const [open, setOpen] = useState(false);
  const bar = Math.round(v.threshold * 100);
  const label = v.outcome === 'approved' ? 'Approved' : v.outcome === 'rejected' ? 'Held back' : 'Not reviewed';
  return (
    <div className={`verdict ${v.outcome}`}>
      <button className="verdict-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="verdict-label">Jury verdict</span>
        <span className={`verdict-pill ${v.outcome}`}>{label}</span>
        {v.mean_score !== null && (
          <span className="verdict-mean">
            {Math.round(v.mean_score * 100)}% <span className="muted small-inline">· the bar is above {bar}%</span>
          </span>
        )}
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      <p className="verdict-summary">{v.ruling ? <ClaimText claim={v.ruling} byId={byId} /> : v.summary}</p>
      {v.ruling && <p className="muted small verdict-code">{v.summary}</p>}
      {open && (
        <div className="jurors">
          {v.jurors.map((j) => {
            const n = JUROR_NAMES[j.role] ?? { name: j.role, asks: '' };
            const pctScore = j.score === null ? 0 : Math.round(j.score * 100);
            return (
              <div key={j.role} className="juror">
                <div className="juror-top">
                  <b>{n.name}</b>
                  <span className="muted small-inline">{n.asks}</span>
                  <span className="juror-score">{j.score === null ? 'did not answer' : `${pctScore}%`}</span>
                </div>
                <div className="juror-bar" title={`The bar is ${bar}%`}>
                  <span className={pctScore / 100 > v.threshold ? 'pass' : 'fail'} style={{ width: `${pctScore}%` }} />
                  <i style={{ left: `${bar}%` }} />
                </div>
                {j.rationale && (
                  <p className="small">
                    <ClaimText claim={j.rationale} byId={byId} />
                  </p>
                )}
              </div>
            );
          })}
          <p className="muted small">
            {v.jurors_answered} of {v.jurors_asked} jurors answered. Code takes the decision from their average and two checks (the AI steps passed their own checks; the screenshot did not contradict the report); the judge only writes the words.
            {v.offline ? ' Scored by the offline stand-in, not Gemini.' : ''}
          </p>
        </div>
      )}
    </div>
  );
}

export function FindingSummary({ finding: f, cluster }: { finding: Finding; cluster: Cluster }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const byId = new Map(f.evidence.map((e) => [e.id, e]));
  const r = f.revenue;
  const offline = f.model_version.split('+').includes(OFFLINE_MODEL);
  const verdict = VERDICTS[f.root_cause?.visual_check ?? 'not_checked'] ?? VERDICTS.not_checked!;
  const latest = cluster.evidence[0];
  const replayHref = latest ? `#/sessions/${latest.session_id}?signal=${latest.signal_id}` : null;
  const steps = f.triage?.repro_steps ?? [];
  const shotHref = f.screenshot ? (evidenceHref(byId.get(f.screenshot.evidence_id)) ?? `#/sessions/${f.screenshot.session_id}?signal=${f.screenshot.signal_id}`) : replayHref;

  return (
    <section className="finding">
      <div className="hero">
        <div className={`hero-money${r.status === 'ok' ? '' : ' pending'}`} title={r.status === 'ok' ? formulaLine(r) : undefined}>
          <span className="hero-label">Estimated revenue lost</span>
          {r.status === 'ok' ? (
            <>
              <div className="hero-amount">{money(r.revenue_at_risk_minor, r.currency)}</div>
              <p className="hero-sub">
                {Number.isInteger(r.affected_with_cart) ? r.affected_with_cart : r.affected_with_cart.toFixed(1)} shoppers with a cart hit this. {pct(r.abandonment_affected)} left, against {pct(r.abandonment_baseline)} normally.
              </p>
            </>
          ) : (
            <>
              <div className="hero-amount muted">Estimating…</div>
              <p className="hero-sub">{r.note}</p>
            </>
          )}
          <span className="hero-note">Synthetic demo data</span>
        </div>

        <div className="hero-main">
          <div className="finding-head">
            <span className="tier" style={{ background: tierColor(f.tier) }}>
              {TIER_NAMES[f.tier] ?? f.tier}
            </span>
            {f.triage && <span className="kind">{CATEGORY_NAMES[f.triage.category] ?? f.triage.category}</span>}
            {f.status === 'suspect' && (
              <span className="suspect" title={f.verdict?.outcome === 'rejected' ? f.verdict.summary : 'The visual check did not show the defect on screen. A person should look before acting.'}>
                Needs review
              </span>
            )}
            {cluster.found_later && cluster.found_later.sessions > 0 && (
              <a className="found-later" href="#/history" title="Open time travel: what we knew before the rule, against what we know now">
                Found later · {cluster.found_later.sessions} of {cluster.session_count} sessions surfaced by re-scanning history
              </a>
            )}
          </div>
          <h1 className="issue-title">{f.title}</h1>
          <p className="muted hero-meta">
            <code>{cluster.anchor}</code> on {cluster.route} · {cluster.session_count} sessions · {cluster.signal_count} signals · first seen {time(cluster.first_seen)}
          </p>
          {replayHref && (
            <a className="btn primary" href={replayHref}>
              ▶ Watch the latest occurrence
            </a>
          )}
        </div>
      </div>

      {offline && (
        <p className="notice">
          Offline stand-in: this analysis is templated from the evidence, not written by Gemini, and the screenshot was not checked. Set <code>GOOGLE_API_KEY</code> and restart <code>pnpm dev</code> for Gemini.
        </p>
      )}

      <div className="scards">
        <SummaryCard
          title="What shoppers hit"
          open={!!open.issue}
          onToggle={() => toggle('issue')}
          summary={
            f.triage ? (
              <>
                <p className="clamp">{plain(f.triage.summary.text)}</p>
                <p className="scard-label">Likely cause</p>
                <p className="clamp small-p">{plain(f.triage.likely_cause.text)}</p>
              </>
            ) : (
              <p className="muted">No agent analysis yet.</p>
            )
          }
          detail={
            f.triage && (
              <>
                <h4>What happened</h4>
                <ClaimText claim={f.triage.summary} byId={byId} />
                <h4>Likely cause</h4>
                <ClaimText claim={f.triage.likely_cause} byId={byId} />
                {f.root_cause && (
                  <>
                    <h4>Root-cause hypothesis</h4>
                    <ClaimText claim={f.root_cause.hypothesis} byId={byId} />
                    <p className="small-p">
                      Look first at: <b>{f.root_cause.suggested_fix_area}</b>
                    </p>
                  </>
                )}
              </>
            )
          }
        />

        <SummaryCard
          title="Proof"
          badge={<span className="verdict" style={{ background: verdict.color }}>{verdict.label}</span>}
          open={!!open.proof}
          onToggle={() => toggle('proof')}
          summary={
            <>
              {f.screenshot && shotHref ? (
                <a href={shotHref} title="Open the replay at this moment">
                  <img className="shot thumb" src={screenshotUrl(f.finding_id, f.screenshot.captured_at)} alt="The flagged moment, rendered from the masked replay, with the element outlined in red" />
                </a>
              ) : (
                <p className="muted small">No screenshot (the visual check is off, or no replay could be rendered).</p>
              )}
              {replayHref && (
                <a className="btn" href={replayHref}>
                  ▶ Watch replay
                </a>
              )}
            </>
          }
          detail={
            <>
              {f.screenshot && shotHref && (
                <a href={shotHref} title="Open the replay at this moment">
                  <img className="shot wide" src={screenshotUrl(f.finding_id, f.screenshot.captured_at)} alt="The flagged moment, rendered from the masked replay, with the element outlined in red" />
                </a>
              )}
              {f.root_cause && (
                <>
                  <h4>What the visual check saw</h4>
                  <ClaimText claim={f.root_cause.visual_notes} byId={byId} />
                </>
              )}
              <h4>Latest occurrences</h4>
              <table className="signals compact">
                <tbody>
                  {cluster.evidence.map((e) => (
                    <tr key={e.signal_id}>
                      <td>{time(e.event_time)}</td>
                      <td>
                        <code>{e.session_id.slice(0, 14)}…</code>
                      </td>
                      <td>
                        <a className="btn tiny" href={`#/sessions/${e.session_id}?signal=${e.signal_id}`}>
                          Watch replay
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">Rendered from the stored, masked replay: inputs and personal text never reach the model.</p>
            </>
          }
        />

        <SummaryCard
          title="How to recreate"
          open={!!open.steps}
          onToggle={() => toggle('steps')}
          summary={
            steps.length > 0 ? (
              <>
                <ol className="steps compact">
                  {steps.slice(0, 3).map((s, i) => (
                    <li key={i}>
                      <span className="clamp1">{plain(s.step)}</span>
                    </li>
                  ))}
                </ol>
                {steps.length > 3 && <p className="muted small">+ {steps.length - 3} more step{steps.length - 3 === 1 ? '' : 's'}</p>}
              </>
            ) : (
              <p className="muted">No steps yet.</p>
            )
          }
          detail={
            <ol className="steps">
              {steps.map((s, i) => (
                <li key={i}>
                  {plain(s.step)} <EvidenceChips ids={s.evidence_ids} byId={byId} />
                </li>
              ))}
            </ol>
          }
        />
      </div>
      {f.verdict && <VerdictCard v={f.verdict} byId={byId} />}
    </section>
  );
}

/** Everything behind the summary, closed by default: scoring, evidence, symptoms, sessions, audit trail. */
export function FindingFolds({ finding: f, versions }: { finding: Finding; versions: FindingVersionView[] }) {
  const byId = new Map(f.evidence.map((e) => [e.id, e]));
  const r = f.revenue;
  const p = f.priority;
  const failed = f.runs.filter((x) => !x.ok);

  return (
    <>
      <Fold title="How it was scored" hint={`${p.base_tier} · score ${f.score.toLocaleString('en-IN')}`}>
        {r.status === 'ok' ? (
          <>
            <p className="formula">{formulaLine(r)}</p>
            <p className="muted small">
              Affected sessions with a cart × average cart × (abandonment of affected sessions − abandonment of the {r.baseline_scope === 'route' ? `baseline on ${f.route}` : 'baseline on all routes'}). {r.affected_abandoned} of{' '}
              {r.affected_decided} affected abandoned; {r.baseline_abandoned} of {r.baseline_decided} baseline.
              {r.pending > 0 ? ` ${r.pending} affected still shopping.` : ''} {r.note ?? ''}
            </p>
          </>
        ) : (
          <p className="muted small">{r.note}</p>
        )}
        <p className="small-p">
          Base tier <b>{p.base_tier}</b> from{' '}
          {p.base_rule_ids.length
            ? p.base_rule_ids.map((id, i) => (
                <span key={id}>
                  {i ? ', ' : ''}
                  <code>{id}</code>
                </span>
              ))
            : 'no rule'}
          {p.tier_move !== 0 ? (
            <>
              , moved {p.tier_move < 0 ? 'up' : 'down'} one tier to <b>{f.tier}</b> by the ranker citing <code>{p.move_rule_id}</code>
            </>
          ) : (
            <>, unchanged by the ranker</>
          )}
          {p.regression ? `, × ${p.multiplier} as a regression after a release` : ''}.
        </p>
        {f.ranker && <ClaimText claim={f.ranker.reason} byId={byId} />}
        <p className="muted small">
          Score {f.score.toLocaleString('en-IN')} = revenue at risk × tier weight{p.regression ? ' × regression multiplier' : ''}. The ranker may move a finding one tier at most, only with a cited rule. Abandonment rates in the demo are set by
          the simulator.
        </p>
      </Fold>

      <Fold title="Evidence the agents saw" hint={`${f.evidence.length} items`}>
        <p className="muted small">As supplied at analysis time ({time(f.runs[0]?.at ?? f.updated_at)}); the analysis re-runs when the issue changes or its sessions double.</p>
        <ul className="evidence">
          {f.evidence.map((e) => {
            const href = evidenceHref(e);
            return (
              <li key={e.id}>
                <span className="ev-chip">{e.id}</span> <span className="ev-kind">{e.kind}</span> {e.text}{' '}
                {href && (
                  <a className="btn tiny" href={href}>
                    Watch replay
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </Fold>

      <Fold title="Audit trail" hint={`${f.runs.length} agent runs · ${versions.length} versions${failed.length ? ` · ${failed.length} rejected` : ''}`}>
        <table className="kv">
          <tbody>
            {f.runs.map((x) => (
              <tr key={x.agent}>
                <td>{x.agent.replace('_', ' ')}</td>
                <td>
                  <code>{x.model}</code> · prompt <code>{x.prompt_hash}</code> · {x.attempts} attempt{x.attempts === 1 ? '' : 's'} · {x.ok ? 'accepted' : <b className="bad">rejected: {x.error}</b>}
                </td>
              </tr>
            ))}
            <tr>
              <td>rule set</td>
              <td>
                <code>{f.rule_version.split(':')[0]}</code>
              </td>
            </tr>
          </tbody>
        </table>
        <h4>Versions</h4>
        <table className="kv versions">
          <tbody>
            {versions
              .slice(-8)
              .reverse()
              .map((v) => (
                <tr key={`${v.recorded_from}-${v.version}`}>
                  <td>v{v.version ?? '?'}</td>
                  <td>
                    {time(v.recorded_from)} → {v.recorded_to ? time(v.recorded_to) : 'current'}
                  </td>
                  <td>
                    <span className="tier sm" style={{ background: tierColor(v.tier) }}>
                      {v.tier}
                    </span>{' '}
                    {money(v.revenue_at_risk_minor, v.currency || null)} · {v.affected_sessions} sessions
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        <p className="muted small">Each change writes a new version row; earlier versions are never overwritten.</p>
      </Fold>
    </>
  );
}
