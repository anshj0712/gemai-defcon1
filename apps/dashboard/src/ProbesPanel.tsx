import { useCallback, useEffect, useState } from 'react';
import type { ProbeDoc, ProbePreview, ProbeSource, RecordedProbeSpec } from '@cp/schema';
import { addProbe, ApiError, disableProbe, fetchProbes, previewProbe, type ProbesView, type ProbeStatsView } from './api';
import { ago, money, time } from './format';
import { probeValue } from './lib/probes';

const SOURCE_LABEL: Record<ProbeSource, string> = { declared: 'In site code', request: 'Request', recorded: 'Recorded' };
const SOURCE_HINT: Record<ProbeSource, string> = {
  declared: "Declared in the store's SDK setup: the browser reads the element and sends only the number.",
  request: 'Automatic: every network call, as how long it took (_ms) and how it ended (_status).',
  recorded: 'Read from the recorded page by a selector, added here or proposed by the agent. Nothing new leaves the browser, and it also reads sessions recorded before it existed.',
};

/** Examples for the demo shop (synthetic): two numbers the shop shows but never declared as probes. */
export const PROBE_EXAMPLES: { label: string; spec: RecordedProbeSpec }[] = [
  { label: 'Delivery fee at checkout', spec: { name: 'delivery_fee', selector: '#delivery-fee', routes: ['/checkout'], kind: 'money' } },
  { label: 'Delivery estimate (days)', spec: { name: 'delivery_days', selector: '#delivery-eta', routes: ['/product/:id'], kind: 'count' } },
];

function range(p: ProbeStatsView, kind?: 'money' | 'count'): string {
  return p.min === p.max ? probeValue(p.name, p.min, kind) : `${probeValue(p.name, p.min, kind)} – ${probeValue(p.name, p.max, kind)}`;
}

function PreviewBlock({ p, spec }: { p: ProbePreview; spec: RecordedProbeSpec }) {
  if (p.sessions_with_value === 0) {
    return (
      <p className="notice">
        <b>It reads nothing yet.</b> {spec.selector} matched no number in the last {p.sessions_scanned} sessions{spec.routes?.length ? ` on ${spec.routes.join(', ')}` : ''}. Check the selector and the page.
      </p>
    );
  }
  return (
    <div className="probe-preview">
      <p className="small-p">
        Read on <b>{p.sessions_with_value}</b> of {p.sessions_scanned} recent sessions ({p.snapshots} snapshots), on {p.routes.join(', ')}. Values{' '}
        <b>
          {p.values ? (p.values.min === p.values.max ? probeValue(spec.name, p.values.min, spec.kind) : `${probeValue(spec.name, p.values.min, spec.kind)} – ${probeValue(spec.name, p.values.max, spec.kind)}`) : '–'}
        </b>
        {p.values && p.values.min !== p.values.max && <> (median {probeValue(spec.name, p.values.median, spec.kind)})</>}. <span className="synthetic-note">synthetic data</span>
      </p>
      {p.samples.length > 0 && (
        <table className="signals compact">
          <tbody>
            {p.samples.map((s) => (
              <tr key={s.session_id}>
                <td>{time(s.event_time)}</td>
                <td>{s.route}</td>
                <td>{probeValue(spec.name, s.value, spec.kind)}</td>
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
    </div>
  );
}

/**
 * Probes: every number the store's sessions report, by where it comes from, and a form to add a recorded probe
 * (a selector read from the recorded page). Rules compare probes; a new probe can be used by a rule at once.
 */
export function ProbesPanel({ onChanged }: { onChanged?: () => void }) {
  const [view, setView] = useState<ProbesView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [spec, setSpec] = useState<RecordedProbeSpec>({ name: '', selector: '', kind: 'money' });
  const [preview, setPreview] = useState<{ spec: RecordedProbeSpec; p: ProbePreview } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(
    () =>
      fetchProbes().then(
        (v) => {
          setView(v);
          setLoadError(null);
        },
        (e: Error) => setLoadError(e.message),
      ),
    [],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(null);
    }
  };

  const edit = (next: Partial<RecordedProbeSpec>) => {
    setSpec((s) => ({ ...s, ...next }));
    setPreview(null);
  };
  const cleanSpec = (): RecordedProbeSpec => ({ name: spec.name.trim(), selector: spec.selector.trim(), kind: spec.kind, ...(spec.routes?.length ? { routes: spec.routes } : {}) });

  const registry = new Map((view?.registry ?? []).map((d) => [d.name, d]));
  const groups: ProbeSource[] = ['declared', 'request', 'recorded'];
  const routes = view?.catalog.routes ?? [];
  const canSave = preview !== null && preview.p.sessions_with_value > 0 && JSON.stringify(preview.spec) === JSON.stringify(cleanSpec());

  return (
    <section className="probes">
      <div className="suggested-head">
        <h2 className="section-title">Probes</h2>
        <span className="muted small-inline">The numbers rules compare. {view ? `From the last ${view.sessions} sessions.` : ''}</span>
      </div>
      {loadError && !view && <p className="muted small-p">Could not load probes ({loadError}).</p>}
      {view && (
        <div className="probe-groups">
          {groups.map((g) => {
            const list = view.catalog.probes.filter((p) => p.source === g);
            const recordedOff = g === 'recorded' ? view.registry.filter((d) => !list.some((p) => p.name === d.name)) : [];
            return (
              <div key={g} className="panel probe-group">
                <h4>
                  <span className={`src ${g}`}>{SOURCE_LABEL[g]}</span>
                </h4>
                <p className="small-p muted">{SOURCE_HINT[g]}</p>
                {list.length === 0 && recordedOff.length === 0 ? (
                  <p className="small-p muted">{g === 'recorded' ? 'None yet. Add one below, or approve one the agent proposes.' : 'None seen in recent sessions.'}</p>
                ) : (
                  <table className="signals compact probe-table">
                    <tbody>
                      {list.map((p) => {
                        const doc = registry.get(p.name);
                        return (
                          <tr key={p.name}>
                            <td>
                              <code>{p.name}</code>
                              {doc && <span className="muted small-inline"> {doc.spec.selector}</span>}
                            </td>
                            <td className="muted">{p.routes.join(', ')}</td>
                            <td>{range(p, doc?.spec.kind)}</td>
                            <td className="muted">{p.snapshots} snapshots</td>
                            {g === 'recorded' && (
                              <td>
                                {doc && <ProbeDocBadge d={doc} />}
                                {doc?.status === 'active' && (
                                  <button className="btn tiny" disabled={busy !== null} onClick={() => void act(`off-${p.name}`, async () => (await disableProbe(p.name), await load(), onChanged?.()))}>
                                    Stop reading
                                  </button>
                                )}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                      {recordedOff.map((d) => (
                        <tr key={d.name}>
                          <td>
                            <code>{d.name}</code> <span className="muted small-inline">{d.spec.selector}</span>
                          </td>
                          <td className="muted">{d.spec.routes?.join(', ') ?? 'every page'}</td>
                          <td className="muted">{d.status === 'active' ? 'no value read yet' : 'not read'}</td>
                          <td />
                          <td>
                            <ProbeDocBadge d={d} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="panel probe-add">
        <button className="btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide' : 'Add a probe'}
        </button>
        {open && (
          <>
            <p className="small-p muted">
              Point at a number the page shows. It is read from the sessions already recorded (text was masked in the browser), so it works on past sessions too, and nothing new is collected from shoppers.
            </p>
            <div className="examples">
              {PROBE_EXAMPLES.map((ex) => (
                <button key={ex.label} className="example" onClick={() => edit(ex.spec)}>
                  {ex.label}: <code>{ex.spec.selector}</code>
                </button>
              ))}
            </div>
            <div className="probe-form">
              <label>
                Name
                <input value={spec.name} onChange={(e) => edit({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} placeholder="delivery_fee" maxLength={64} />
              </label>
              <label>
                CSS selector
                <input value={spec.selector} onChange={(e) => edit({ selector: e.target.value })} placeholder="#delivery-fee" maxLength={200} />
              </label>
              <label>
                Page
                <select value={spec.routes?.[0] ?? ''} onChange={(e) => edit({ routes: e.target.value ? [e.target.value] : [] })}>
                  <option value="">Every page</option>
                  {[...new Set([...routes, ...(spec.routes ?? [])])].map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Kind
                <select value={spec.kind} onChange={(e) => edit({ kind: e.target.value as RecordedProbeSpec['kind'] })}>
                  <option value="money">Money</option>
                  <option value="count">Number (first whole number)</option>
                </select>
              </label>
            </div>
            <p className="small-p muted">Selectors: tag, #id, .class, [attr] or [attr="value"], and descendant or &gt; combinators.</p>
            <div className="row-actions">
              <button
                className="btn"
                disabled={busy !== null || !spec.name || !spec.selector}
                onClick={() =>
                  void act('preview', async () => {
                    const s = cleanSpec();
                    setPreview({ spec: s, p: (await previewProbe(s)).preview });
                  })
                }
              >
                {busy === 'preview' ? 'Reading recent sessions…' : 'Preview'}
              </button>
              <button
                className="btn primary"
                disabled={busy !== null || !canSave}
                title={canSave ? undefined : 'Preview first: a probe must read something'}
                onClick={() =>
                  void act('save', async () => {
                    await addProbe(cleanSpec());
                    setPreview(null);
                    setSpec({ name: '', selector: '', kind: 'money' });
                    await load();
                    onChanged?.();
                  })
                }
              >
                {busy === 'save' ? 'Saving…' : 'Save probe'}
              </button>
            </div>
            {preview && <PreviewBlock p={preview.p} spec={preview.spec} />}
            {error && (
              <div className="notice">
                <b>That did not work.</b> {error.message}
                {error instanceof ApiError && error.code === 'probe_reads_nothing' && <p className="small-p muted">Open a replay of a session on that page to check the element.</p>}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ProbeDocBadge({ d }: { d: ProbeDoc }) {
  return (
    <span className={`probe-status ${d.status}`} title={`v${d.version} · ${d.source === 'agent' ? 'proposed by the agent' : 'added by a merchant'} · approved by ${d.approved_by} ${ago(d.updated_at)}`}>
      {d.status === 'active' ? (d.source === 'agent' ? 'agent · live' : 'live') : 'stopped'}
    </span>
  );
}
