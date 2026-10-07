import type { Claim, EvidenceItem, Finding } from '@cp/schema';
import { screenshotUrl, type FindingVersionView } from './api';
import { CATEGORY_NAMES, formulaLine, money, pct, TIER_NAMES, tierColor, time } from './format';

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
      {claim.text} <EvidenceChips ids={claim.evidence_ids} byId={byId} />
    </p>
  );
}

/**
 * The finding for one issue: revenue at risk and its formula, the tier and the priority rules behind
 * it, the agents' analysis with every claim linked to its evidence (signals open the replay), the
 * visual check, and the reproducibility record (models, prompt hash, rule set, versions).
 */
export function FindingPanel({ finding: f, versions }: { finding: Finding; versions: FindingVersionView[] }) {
  const byId = new Map(f.evidence.map((e) => [e.id, e]));
  const r = f.revenue;
  const offline = f.model_version.split('+').includes(OFFLINE_MODEL);
  const verdict = VERDICTS[f.root_cause?.visual_check ?? 'not_checked'] ?? VERDICTS.not_checked!;
  const failed = f.runs.filter((x) => !x.ok);
  const p = f.priority;

  return (
    <section className="finding">
      <div className="finding-head">
        <span className="tier" style={{ background: tierColor(f.tier) }}>
          {TIER_NAMES[f.tier] ?? f.tier}
        </span>
        {f.triage && <span className="kind">{CATEGORY_NAMES[f.triage.category] ?? f.triage.category}</span>}
        {f.status === 'suspect' && (
          <span className="suspect" title="The visual check did not show the defect on screen. A person should look before acting.">
            Needs review
          </span>
        )}
        <span className="muted small-inline">
          finding v{f.version} · scored {time(f.updated_at)}
        </span>
      </div>
      <h1 className="issue-title">{f.title}</h1>
      {f.title !== f.cluster_title && <p className="muted">Detected as: {f.cluster_title}</p>}

      {offline && (
        <p className="notice">
          Offline stand-in: this analysis is templated from the evidence, not written by Gemini, and the screenshot was not checked. Set <code>GOOGLE_API_KEY</code> and
          restart <code>pnpm dev</code> for Gemini.
        </p>
      )}

      <div className="finding-grid">
        <div className="panel">
          <h3>Revenue at risk</h3>
          {r.status === 'ok' ? (
            <>
              <div className="rar">{money(r.revenue_at_risk_minor, r.currency)}</div>
              <p className="formula">{formulaLine(r)}</p>
              <p className="muted small">
                Affected sessions with a cart × average cart × (abandonment of affected sessions − abandonment of the {r.baseline_scope === 'route' ? `baseline on ${f.route}` : 'baseline on all routes'}
                ). {r.affected_abandoned} of {r.affected_decided} affected abandoned; {r.baseline_abandoned} of {r.baseline_decided} baseline.
                {r.pending > 0 ? ` ${r.pending} affected still shopping.` : ''}
              </p>
            </>
          ) : (
            <>
              <div className="rar muted">Estimating…</div>
              <p className="muted small">{r.note}</p>
            </>
          )}
          {r.note && r.status === 'ok' && <p className="muted small">{r.note}</p>}
          <p className="synthetic-note">Synthetic demo data: abandonment rates are set by the simulator.</p>

          <h3>Priority</h3>
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
            Score {f.score.toLocaleString('en-IN')} = revenue at risk × tier weight{p.regression ? ' × regression multiplier' : ''}. The ranker may move a finding one tier at most, only with a cited rule.
          </p>
        </div>

        <div className="panel">
          <h3>What shoppers hit</h3>
          {f.triage ? <ClaimText claim={f.triage.summary} byId={byId} /> : <p className="muted">No agent analysis yet{failed.length ? ' (the agent output was rejected; see below)' : ''}.</p>}
          {f.triage && (
            <>
              <h3>Steps to reproduce</h3>
              <ol className="steps">
                {f.triage.repro_steps.map((s, i) => (
                  <li key={i}>
                    {s.step} <EvidenceChips ids={s.evidence_ids} byId={byId} />
                  </li>
                ))}
              </ol>
              <h3>Likely cause</h3>
              <ClaimText claim={f.triage.likely_cause} byId={byId} />
            </>
          )}
          {f.root_cause && (
            <>
              <h3>Root-cause hypothesis</h3>
              <ClaimText claim={f.root_cause.hypothesis} byId={byId} />
              <p className="small-p">
                Look first at: <b>{f.root_cause.suggested_fix_area}</b>
              </p>
            </>
          )}
        </div>

        <div className="panel">
          <h3>
            Visual check <span className="verdict" style={{ background: verdict.color }}>{verdict.label}</span>
          </h3>
          {f.screenshot ? (
            <a href={evidenceHref(byId.get(f.screenshot.evidence_id)) ?? `#/sessions/${f.screenshot.session_id}?signal=${f.screenshot.signal_id}`} title="Open the replay at this moment">
              <img className="shot" src={screenshotUrl(f.finding_id, f.screenshot.captured_at)} alt="The flagged moment, rendered from the masked replay, with the element outlined in red" />
            </a>
          ) : (
            <p className="muted small">No screenshot (VISUAL_CHECK is off, or no replay could be rendered).</p>
          )}
          {f.root_cause && <ClaimText claim={f.root_cause.visual_notes} byId={byId} />}
          <p className="muted small">Rendered from the stored, masked replay: inputs and personal text never reach the model.</p>
        </div>
      </div>

      <div className="finding-grid two">
        <div className="panel">
          <h3>Evidence the agents saw ({f.evidence.length})</h3>
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
        </div>
        <div className="panel">
          <h3>Reproducibility</h3>
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
          <h3>Versions ({versions.length})</h3>
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
          <p className="muted small">Each change writes a new version row; earlier versions are never overwritten (abandonment {pct(r.abandonment_affected)} affected vs {pct(r.abandonment_baseline)} baseline now).</p>
        </div>
      </div>
    </section>
  );
}
