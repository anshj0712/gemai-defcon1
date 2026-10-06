import { CUSTOM_TAGS, FLAG_TAG_PREFIX } from '@cp/schema/tags';

/** A flagged moment as returned by GET /v1/sessions/:id/replay. */
export interface Marker {
  signal_id: string;
  detector: string;
  label: string;
  /** Browser-clock ms, comparable with rrweb event timestamps. */
  replay_ts: number;
  event_time: number;
  seq: number;
  selector: string | null;
  node_id: number | null;
  fingerprint: string;
}

/** Payload of the Custom events the viewer injects so flags appear on the player's timeline. */
export interface FlagPayload {
  signal_id: string;
  detector: string;
  label: string;
  selector: string | null;
  node_id: number | null;
}

export interface TimedEvent {
  type: number;
  timestamp: number;
}

export interface FlagEvent extends TimedEvent {
  type: 5;
  data: { tag: string; payload: FlagPayload };
}

export const FLAG_COLORS: Record<string, string> = {
  dead_click: '#ef4444',
  rage_click: '#f97316',
  response_decay: '#eab308',
  invariant_check: '#a855f7',
  error_correlation: '#ec4899',
};

export const flagTag = (detector: string) => `${FLAG_TAG_PREFIX}${detector}`;

export function isFlagEvent(e: unknown): e is FlagEvent {
  const ev = e as Partial<FlagEvent> | null;
  return !!ev && ev.type === 5 && typeof ev.data?.tag === 'string' && ev.data.tag.startsWith(FLAG_TAG_PREFIX);
}

/**
 * Merge flag events into the recording in time order. A flag sharing a timestamp with recorded
 * events goes after them, so the click is replayed before its flag appears. Inputs are not modified.
 */
export function injectMarkers<E extends TimedEvent>(events: readonly E[], markers: readonly Marker[]): (E | FlagEvent)[] {
  const flags: FlagEvent[] = [...markers]
    .sort((a, b) => a.replay_ts - b.replay_ts)
    .map((m) => ({
      type: 5,
      timestamp: m.replay_ts,
      data: { tag: flagTag(m.detector), payload: { signal_id: m.signal_id, detector: m.detector, label: m.label, selector: m.selector, node_id: m.node_id } },
    }));
  const out: (E | FlagEvent)[] = [];
  let i = 0;
  for (const e of events) {
    while (i < flags.length && flags[i]!.timestamp < e.timestamp) out.push(flags[i++]!);
    out.push(e);
  }
  while (i < flags.length) out.push(flags[i++]!);
  return out;
}

/** JS errors stay on the timeline as context, in their own color. */
export const ERROR_COLOR = '#db2777';

/** Timeline colors: one per detector present, plus recorded JS errors. */
export function tagColors(markers: readonly Marker[]): Record<string, string> {
  return {
    [CUSTOM_TAGS.error]: ERROR_COLOR,
    ...Object.fromEntries(markers.map((m) => [flagTag(m.detector), FLAG_COLORS[m.detector] ?? '#ef4444'])),
  };
}

/**
 * Events handed to the player: the recording plus flags. Recorded custom events other than JS
 * errors (network and navigation metadata) are dropped: they draw nothing and would clutter the
 * timeline, which then shows only what matters (flags and errors).
 */
export function forPlayer<E extends TimedEvent>(events: readonly E[], markers: readonly Marker[]): (E | FlagEvent)[] {
  const kept = events.filter((e) => {
    if (e.type !== 5) return true;
    const tag = (e as unknown as { data?: { tag?: unknown } }).data?.tag;
    return tag === CUSTOM_TAGS.error;
  });
  return injectMarkers(kept, markers);
}

/** The short clip around a flag: a few seconds of lead-up and a moment after, within the recording. */
export function clipWindow(offsetMs: number, totalMs: number, beforeMs = 6000, afterMs = 3000): [number, number] {
  const start = Math.max(0, offsetMs - beforeMs);
  const end = Math.min(totalMs, offsetMs + afterMs);
  return [start, Math.max(start, end)];
}

export function formatOffset(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
