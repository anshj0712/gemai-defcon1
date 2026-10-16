import { checkRule, invariantCheck, runDetectors, toSignalRows } from '@cp/detectors';
import { ruleVersionOf, type DryRun, type DryRunSample, type InvariantRule, type ProbePreview, type ProbeSource, type SignalRow } from '@cp/schema';
import type { SessionProbes } from './scan.js';

/**
 * Deterministic evaluation of invariant rules over probe snapshots read back from raw. The real
 * invariant_check detector runs, chunk by chunk with its state carried, so a dry run or re-scan flags
 * exactly what live detection would have (AGENTS.md rule 1: code decides what is a finding).
 */

export interface SessionCheck {
  signals: SignalRow[];
  /** Snapshots where at least one rule applied (route matched, required probes present). */
  applicable: number;
}

/** The signal rows `rules` would have produced for one session, stamped with `ingestTime` (and `rescanId`). */
export function checkSession(tenantId: string, session: SessionProbes, rules: InvariantRule[], ingestTime: number, rescanId?: string): SessionCheck {
  let state: unknown;
  let applicable = 0;
  const signals: SignalRow[] = [];
  for (const chunk of session.chunks) {
    if (chunk.probes.length === 0) continue;
    for (const p of chunk.probes) if (rules.some((r) => checkRule(r, p.values, p.route ?? chunk.pageRoute).applicable)) applicable += 1;
    const runs = runDetectors(
      [invariantCheck],
      { tenantId, sessionId: session.session_id, release: chunk.release, route: chunk.pageRoute, tail: [], prevHorizon: null },
      { sessionId: session.session_id, seq: chunk.seq, route: chunk.pageRoute, tStart: chunk.tStart, tEnd: chunk.tEnd, events: chunk.probes },
      {},
      { rules, ...(state !== undefined ? { state: { [invariantCheck.id]: state } } : {}) },
    );
    const run = runs[0]!;
    if (run.error) throw run.error;
    state = run.state;
    signals.push(
      ...toSignalRows(runs, { tenantId, sessionId: session.session_id, pageRoute: chunk.pageRoute, release: chunk.release, ingestTime, ...(rescanId ? { rescanId } : {}) }),
    );
  }
  return { signals, applicable };
}

// ---------------------------------------------------------------------------------------------
// Probe catalog: what the rule author may refer to (names, where they appear, and their ranges).
// ---------------------------------------------------------------------------------------------

export interface ProbeStats {
  name: string;
  /** Declared in the site's SDK setup, a request (automatic), or recorded (read from the recorded page). */
  source: ProbeSource;
  /** Snapshots carrying this probe. */
  snapshots: number;
  /** How many values one snapshot carries (for example one per bag line). */
  values_per_snapshot: { min: number; max: number };
  min: number;
  median: number;
  max: number;
  routes: string[];
}

export interface ProbeCatalog {
  probes: ProbeStats[];
  routes: string[];
  currencies: string[];
  sessions: number;
}

/** Most values sampled per probe for the median (bounded memory over large windows). */
const MAX_SAMPLE = 5_000;

export function buildCatalog(sessions: readonly SessionProbes[]): ProbeCatalog {
  const acc = new Map<string, { source: ProbeSource; snapshots: number; perMin: number; perMax: number; min: number; max: number; sample: number[]; routes: Set<string> }>();
  const routes = new Set<string>();
  const currencies = new Set<string>();
  let withProbes = 0;
  for (const s of sessions) {
    let any = false;
    for (const c of s.chunks) {
      for (const p of c.probes) {
        any = true;
        const route = p.route ?? c.pageRoute;
        routes.add(route);
        if (p.currency) currencies.add(p.currency);
        for (const [name, values] of Object.entries(p.values)) {
          let a = acc.get(name);
          if (!a) acc.set(name, (a = { source: p.source ?? 'declared', snapshots: 0, perMin: Infinity, perMax: 0, min: Infinity, max: -Infinity, sample: [], routes: new Set() }));
          a.snapshots += 1;
          a.perMin = Math.min(a.perMin, values.length);
          a.perMax = Math.max(a.perMax, values.length);
          a.routes.add(route);
          for (const v of values) {
            a.min = Math.min(a.min, v);
            a.max = Math.max(a.max, v);
            if (a.sample.length < MAX_SAMPLE) a.sample.push(v);
          }
        }
      }
    }
    if (any) withProbes += 1;
  }
  const probes = [...acc.entries()]
    .map(([name, a]): ProbeStats => {
      const sorted = [...a.sample].sort((x, y) => x - y);
      return {
        name,
        source: a.source,
        snapshots: a.snapshots,
        values_per_snapshot: { min: a.perMin === Infinity ? 0 : a.perMin, max: a.perMax },
        min: a.min === Infinity ? 0 : a.min,
        median: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0,
        max: a.max === -Infinity ? 0 : a.max,
        routes: [...a.routes].sort(),
      };
    })
    .sort((x, y) => (x.name < y.name ? -1 : 1));
  return { probes, routes: [...routes].sort(), currencies: [...currencies].sort(), sessions: withProbes };
}

// ---------------------------------------------------------------------------------------------
// Dry run: what a draft would flag, written nowhere.
// ---------------------------------------------------------------------------------------------

const MAX_SAMPLES = 5;

export function dryRun(opts: {
  tenantId: string;
  rule: InvariantRule;
  sessions: readonly SessionProbes[];
  window: { from: number; to: number };
  /** Sessions already in some issue (to show how much the rule adds). */
  inIssues: ReadonlySet<string>;
  truncated: boolean;
  now: number;
  startedAt: number;
  /** Called once per hit session with the route of its first hit (for example to estimate revenue lost over the hits). */
  onHit?: (sessionId: string, route: string) => void;
}): DryRun {
  let applicableSessions = 0;
  let snapshots = 0;
  const hits: DryRunSample[] = [];
  const hitSessions = new Set<string>();
  for (const s of opts.sessions) {
    const check = checkSession(opts.tenantId, s, [opts.rule], opts.now);
    snapshots += check.applicable;
    if (check.applicable > 0) applicableSessions += 1;
    if (check.signals.length === 0) continue;
    hitSessions.add(s.session_id);
    const first = check.signals[0]!;
    opts.onHit?.(s.session_id, first.route);
    const v = (first.evidence.values ?? {}) as Record<string, unknown>;
    const num = (x: unknown) => (typeof x === 'number' ? x : null);
    hits.push({
      session_id: s.session_id,
      seq: first.seq,
      event_time: first.event_time,
      route: first.route,
      left: num(v.actual),
      right: num(v.expected),
      delta: num(v.delta),
      currency: typeof v.currency === 'string' ? v.currency : null,
      in_issue: opts.inIssues.has(s.session_id),
    });
  }
  // Newest first, preferring sessions no issue holds yet (what the rule would add).
  hits.sort((a, b) => Number(a.in_issue) - Number(b.in_issue) || b.event_time - a.event_time);
  return {
    rule_version: ruleVersionOf(opts.rule),
    window: opts.window,
    sessions_scanned: opts.sessions.length,
    sessions_applicable: applicableSessions,
    sessions_hit: hitSessions.size,
    snapshots_checked: snapshots,
    hit_rate: applicableSessions ? hitSessions.size / applicableSessions : null,
    hits_in_issues: hits.filter((h) => h.in_issue).length,
    samples: hits.slice(0, MAX_SAMPLES),
    truncated: opts.truncated,
    ms: opts.now - opts.startedAt,
    at: opts.now,
  };
}

// ---------------------------------------------------------------------------------------------
// Recorded probe preview: what a selector would read over recent sessions, before anyone saves it.
// ---------------------------------------------------------------------------------------------

const MAX_PREVIEW_SAMPLES = 5;

/** What the recorded probe `name` read over sessions scanned with it. Numbers, routes and session ids only. */
export function previewProbe(name: string, sessions: readonly SessionProbes[], window: { from: number; to: number }, now: number): ProbePreview {
  let withValue = 0;
  let snapshots = 0;
  const values: number[] = [];
  const routes = new Set<string>();
  const samples: ProbePreview['samples'] = [];
  for (const s of sessions) {
    let first: ProbePreview['samples'][number] | null = null;
    for (const c of s.chunks) {
      for (const p of c.probes) {
        const v = p.values[name];
        if (!v || v.length === 0) continue;
        snapshots += 1;
        const route = p.route ?? c.pageRoute;
        routes.add(route);
        if (values.length < MAX_SAMPLE) values.push(...v.slice(0, 10));
        first ??= { session_id: s.session_id, event_time: p.t, route, value: v[0]! };
      }
    }
    if (first) {
      withValue += 1;
      if (samples.length < MAX_PREVIEW_SAMPLES) samples.push(first);
    }
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    sessions_scanned: sessions.length,
    sessions_with_value: withValue,
    snapshots,
    values: sorted.length ? { min: sorted[0]!, median: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]! } : null,
    routes: [...routes].sort(),
    samples,
    window,
    at: now,
  };
}