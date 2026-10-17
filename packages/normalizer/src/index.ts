import { EventType, IncrementalSource, MouseInteractions } from '@rrweb/types';
import {
  CUSTOM_TAGS,
  ErrorPayload,
  NavPayload,
  NetPayload,
  ProbePayload,
  requestProbeNames,
  type NormalizedEvent,
  type NormalizerState,
  type ProbeMemo,
  type RecordedProbeSpec,
} from '@cp/schema';
import { applyMutation, emptyState, indexSubtree, pruneState, resolveTarget, type MutationRecordLike } from './dom-index.js';
import { applyMirrorMutation, mirrorSnapshot, numericCandidates, readRecordedProbes, type MirrorMutation, type NumericCandidate } from './mirror.js';

export { emptyState, isDisabled, isInteractive, resolveTarget, selectorFor } from './dom-index.js';
export { compileSelector, emptyMirror, MAX_MIRROR_NODES, numericCandidates, queryMirror, readRecordedProbes, textOf, type NumericCandidate } from './mirror.js';

/** A page change is read once the page has been quiet this long (as the SDK snapshots its declared probes). */
export const SETTLE_MS = 250;

export interface NormalizeOptions {
  /** Sequence number of the chunk being normalized. */
  seq: number;
  /** Added to every client timestamp to get valid time (collector_received_at - client_sent_at). */
  skewMs: number;
  /** State carried from the previous chunk of the session (emptyState() for the first). */
  state: NormalizerState;
  /** Recorded probes to read from the recorded page (keeps the page mirror). */
  recordedProbes?: readonly RecordedProbeSpec[];
  /**
   * Keep the page mirror even with no recorded probes, so a probe registered mid-session is read from the
   * session's next page change rather than its next full page load.
   */
  mirror?: boolean;
  /** Collect numbers on the page nobody probes yet, at every settled page change (the churn watcher). */
  discover?: boolean;
  /** Turn every finished request into `req_<method>_<path>_ms` and `_status` probes (default true). */
  requestProbes?: boolean;
}

export interface NormalizeStats {
  input: number;
  clicks: number;
  mutations: number;
  navigations: number;
  inputs: number;
  requests: number;
  errors: number;
  /** Declared probe snapshots from the SDK. */
  probes: number;
  /** Probe events derived here: request probes and recorded-probe snapshots. */
  derived_probes: number;
  ignored: number;
}

/** Numbers on the page at one settled moment (discover mode). */
export interface DiscoveredValues {
  t: number;
  route: string | null;
  candidates: NumericCandidate[];
}

export interface NormalizeResult {
  events: NormalizedEvent[];
  state: NormalizerState;
  stats: NormalizeStats;
  /** Discover mode only. */
  discovered?: DiscoveredValues[];
}

interface RawEvent {
  type: number;
  timestamp: number;
  data?: Record<string, unknown>;
}

function isRawEvent(v: unknown): v is RawEvent {
  return typeof v === 'object' && v !== null && typeof (v as RawEvent).type === 'number' && typeof (v as RawEvent).timestamp === 'number';
}

function pathOf(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  try {
    return new URL(href).pathname;
  } catch {
    return href.split(/[?#]/)[0] || null;
  }
}

/**
 * Turns one chunk of rrweb events into the normalized stream detectors read. Pure: the same input
 * always yields the same output, and the input state is not modified.
 */
export function normalize(rawEvents: readonly unknown[], opts: NormalizeOptions): NormalizeResult {
  const state: NormalizerState = structuredClone(opts.state ?? emptyState());
  const events: NormalizedEvent[] = [];
  const stats: NormalizeStats = { input: rawEvents.length, clicks: 0, mutations: 0, navigations: 0, inputs: 0, requests: 0, errors: 0, probes: 0, derived_probes: 0, ignored: 0 };
  const { seq, skewMs } = opts;
  const specs = opts.recordedProbes ?? [];
  const keepMirror = Boolean(opts.mirror || opts.discover || specs.length > 0);
  const requestProbes = opts.requestProbes !== false;
  const discovered: DiscoveredValues[] = [];
  if (!keepMirror) {
    delete state.mirror;
    delete state.probe_memo;
  }
  const memo: ProbeMemo = state.probe_memo ?? { last: null, pending: null, currency: null };

  /** Read the recorded page once it has settled: recorded probes (when they changed) and, in discover mode, every number. */
  const settle = (at: number) => {
    if (!keepMirror || memo.pending === null) return;
    memo.pending = null;
    const mirror = state.mirror;
    if (!mirror) return;
    const route = state.route ?? null;
    if (specs.length > 0) {
      const values = readRecordedProbes(mirror, specs, route);
      const key = `${route}|${JSON.stringify(values)}`;
      if (key !== memo.last && Object.keys(values).length > 0) {
        events.push({ kind: 'probe', t: at, seq, values, currency: memo.currency, route, source: 'recorded' });
        stats.derived_probes++;
      }
      memo.last = key;
    }
    if (opts.discover) {
      const candidates = numericCandidates(mirror);
      if (candidates.length > 0) discovered.push({ t: at, route, candidates });
    }
  };

  for (const raw of rawEvents) {
    if (!isRawEvent(raw)) {
      stats.ignored++;
      continue;
    }
    const t = raw.timestamp + skewMs;
    const data = raw.data ?? {};
    if (memo.pending !== null && t - memo.pending >= SETTLE_MS) settle(memo.pending + SETTLE_MS);

    switch (raw.type) {
      case EventType.Meta: {
        const path = pathOf(data.href);
        // A new page: whatever the old one showed last is read under its own route first.
        settle(t);
        if (path !== null && state.path !== null && path !== state.path) {
          events.push({ kind: 'navigation', t, seq, reason: 'load', route: path });
          stats.navigations++;
        }
        if (path !== null) {
          state.path = path;
          state.route = path;
        }
        break;
      }

      case EventType.FullSnapshot: {
        // A new document: node ids restart from this snapshot.
        state.nodes = {};
        state.alias = {};
        indexSubtree(state, data.node, null);
        if (keepMirror) {
          state.mirror = mirrorSnapshot(data.node);
          memo.pending = t;
        }
        break;
      }

      case EventType.IncrementalSnapshot: {
        const source = data.source;
        if (source === IncrementalSource.Mutation) {
          const m = data as MutationRecordLike & { texts?: unknown[] };
          applyMutation(state, m);
          if (keepMirror && state.mirror) {
            applyMirrorMutation(state.mirror, data as MirrorMutation);
            memo.pending = t;
          }
          const count = (m.adds?.length ?? 0) + (m.removes?.length ?? 0) + (m.texts?.length ?? 0) + (m.attributes?.length ?? 0);
          if (count > 0) {
            events.push({ kind: 'mutation', t, seq, count });
            stats.mutations++;
          }
        } else if (source === IncrementalSource.MouseInteraction && data.type === MouseInteractions.Click && typeof data.id === 'number') {
          const target = resolveTarget(state, data.id);
          events.push({
            kind: 'click',
            t,
            seq,
            nodeId: target?.id ?? data.id,
            selector: target?.entry.selector ?? null,
            tag: target?.entry.tag ?? null,
            interactive: target?.entry.interactive ?? false,
            disabled: target?.entry.disabled ?? false,
            route: state.route ?? null,
            ...(typeof data.x === 'number' ? { x: data.x } : {}),
            ...(typeof data.y === 'number' ? { y: data.y } : {}),
          });
          stats.clicks++;
        } else if (source === IncrementalSource.Input && typeof data.id === 'number') {
          // Never the typed text: only that an input changed.
          events.push({ kind: 'input', t, seq, nodeId: data.id });
          stats.inputs++;
        } else {
          stats.ignored++;
        }
        break;
      }

      case EventType.Custom: {
        const e = customEvent(data, t, seq, state.route ?? null);
        if (!e) {
          stats.ignored++;
          break;
        }
        if (e.kind === 'navigation') settle(t);
        events.push(e);
        if (e.kind === 'navigation' && e.route) state.route = e.route;
        if (e.kind === 'request') {
          stats.requests++;
          if (requestProbes && e.phase === 'end') {
            // A finished request is also a probe: how long it took and how it ended.
            const names = requestProbeNames(e.method, e.route);
            events.push({ kind: 'probe', t: e.tEnd, seq, values: { [names.ms]: [e.tEnd - e.t], [names.status]: [e.status] }, currency: null, route: state.route ?? null, source: 'request' });
            stats.derived_probes++;
          }
        } else if (e.kind === 'error') stats.errors++;
        else if (e.kind === 'probe') {
          stats.probes++;
          if (e.currency) memo.currency = e.currency;
        } else if (e.kind === 'navigation') stats.navigations++;
        break;
      }

      default:
        stats.ignored++;
    }
  }

  // The batch ends here: what the page shows now is what the shopper last saw of it in this batch.
  const last = rawEvents.length > 0 ? rawEvents[rawEvents.length - 1] : undefined;
  if (memo.pending !== null && isRawEvent(last)) settle(Math.max(memo.pending, last.timestamp + skewMs));

  pruneState(state);
  if (keepMirror) state.probe_memo = memo;
  return { events, state, stats, ...(opts.discover ? { discovered } : {}) };
}

function customEvent(data: Record<string, unknown>, t: number, seq: number, route: string | null): NormalizedEvent | null {
  const payload = data.payload;
  switch (data.tag) {
    case CUSTOM_TAGS.net: {
      const p = NetPayload.safeParse(payload);
      if (!p.success) return null;
      const { phase, method, route, status, duration_ms } = p.data;
      return phase === 'start'
        ? { kind: 'request', phase, t, tEnd: t, seq, method, route, status: 0 }
        : { kind: 'request', phase, t: t - duration_ms, tEnd: t, seq, method, route, status };
    }
    case CUSTOM_TAGS.error: {
      const p = ErrorPayload.safeParse(payload);
      return p.success ? { kind: 'error', t, seq, errorKind: p.data.kind, signature: p.data.signature } : null;
    }
    case CUSTOM_TAGS.probe: {
      const p = ProbePayload.safeParse(payload);
      return p.success ? { kind: 'probe', t, seq, values: p.data.values, currency: p.data.currency ?? null, route } : null;
    }
    case CUSTOM_TAGS.nav: {
      const p = NavPayload.safeParse(payload);
      return p.success ? { kind: 'navigation', t, seq, reason: p.data.reason, route: p.data.route ?? null } : null;
    }
    default:
      return null;
  }
}
