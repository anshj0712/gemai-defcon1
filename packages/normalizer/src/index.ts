import { EventType, IncrementalSource, MouseInteractions } from '@rrweb/types';
import {
  CUSTOM_TAGS,
  ErrorPayload,
  NavPayload,
  NetPayload,
  ProbePayload,
  type NormalizedEvent,
  type NormalizerState,
} from '@cp/schema';
import { applyMutation, emptyState, indexSubtree, pruneState, resolveTarget, type MutationRecordLike } from './dom-index.js';

export { emptyState, isDisabled, isInteractive, resolveTarget, selectorFor } from './dom-index.js';

export interface NormalizeOptions {
  /** Sequence number of the chunk being normalized. */
  seq: number;
  /** Added to every client timestamp to get valid time (collector_received_at - client_sent_at). */
  skewMs: number;
  /** State carried from the previous chunk of the session (emptyState() for the first). */
  state: NormalizerState;
}

export interface NormalizeStats {
  input: number;
  clicks: number;
  mutations: number;
  navigations: number;
  inputs: number;
  requests: number;
  errors: number;
  probes: number;
  ignored: number;
}

export interface NormalizeResult {
  events: NormalizedEvent[];
  state: NormalizerState;
  stats: NormalizeStats;
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
  const stats: NormalizeStats = { input: rawEvents.length, clicks: 0, mutations: 0, navigations: 0, inputs: 0, requests: 0, errors: 0, probes: 0, ignored: 0 };
  const { seq, skewMs } = opts;

  for (const raw of rawEvents) {
    if (!isRawEvent(raw)) {
      stats.ignored++;
      continue;
    }
    const t = raw.timestamp + skewMs;
    const data = raw.data ?? {};

    switch (raw.type) {
      case EventType.Meta: {
        const path = pathOf(data.href);
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
        break;
      }

      case EventType.IncrementalSnapshot: {
        const source = data.source;
        if (source === IncrementalSource.Mutation) {
          const m = data as MutationRecordLike & { texts?: unknown[] };
          applyMutation(state, m);
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
        events.push(e);
        if (e.kind === 'navigation' && e.route) state.route = e.route;
        if (e.kind === 'request') stats.requests++;
        else if (e.kind === 'error') stats.errors++;
        else if (e.kind === 'probe') stats.probes++;
        else if (e.kind === 'navigation') stats.navigations++;
        break;
      }

      default:
        stats.ignored++;
    }
  }

  pruneState(state);
  return { events, state, stats };
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
