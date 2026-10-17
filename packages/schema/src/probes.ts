import { z } from 'zod';

/**
 * Probes are numbers a session reports, which rules compare. They come from three places, and all of them
 * reach detectors the same way, as `probe` events in the normalized stream (ARCHITECTURE.md section 4):
 *
 *   declared  named in the site's SDK setup; the browser parses the element's text and sends the number
 *   request   automatic: every finished fetch or XHR as `req_<method>_<path>_ms` and `..._status`
 *   recorded  a name, a CSS selector and a page, registered on the dashboard (by a merchant, or proposed by the
 *             agent and approved by a person). The normalizer reads it from the recording it already has: the
 *             page text rrweb captured, already masked. Nothing new leaves the browser, and it applies to
 *             sessions recorded before the probe existed (re-scans).
 */

export const PROBE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
export const ProbeKindSchema = z.enum(['money', 'count']);
export type ProbeKind = z.infer<typeof ProbeKindSchema>;
export type ProbeSource = 'declared' | 'request' | 'recorded';

/** A probe read from the recorded page: which elements, on which pages, parsed as money or a count. */
export const RecordedProbeSpecSchema = z.object({
  name: z.string().regex(PROBE_NAME),
  /** A small CSS subset: tag, #id, .class, [attr], [attr="v"], descendant and child (>) combinators. */
  selector: z.string().min(1).max(200),
  /** Route templates where it is read (for example "/checkout"); omitted means every page. */
  routes: z.array(z.string().min(1).max(256)).max(10).optional(),
  kind: ProbeKindSchema,
});
export type RecordedProbeSpec = z.infer<typeof RecordedProbeSpecSchema>;

export const REQUEST_PROBE_PREFIX = 'req_';
/** Longest request probe base, leaving room for "_status". */
const MAX_BASE = 56;

/** FNV-1a, base 36: a short stable suffix for names cut to length. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).slice(0, 6);
}

/** `POST /api/payment/authorize` -> `req_post_api_payment_authorize` (the `_ms` and `_status` probes share it). */
export function requestProbeBase(method: string, route: string): string {
  const slug = `${method} ${route}`
    .toLowerCase()
    .replace(/:id\b/g, 'id')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const base = `${REQUEST_PROBE_PREFIX}${slug || 'request'}`;
  return base.length <= MAX_BASE ? base : `${base.slice(0, MAX_BASE - 7)}_${shortHash(base)}`;
}

export const requestProbeNames = (method: string, route: string) => {
  const base = requestProbeBase(method, route);
  return { ms: `${base}_ms`, status: `${base}_status` };
};

export const isRequestProbe = (name: string) => name.startsWith(REQUEST_PROBE_PREFIX) && (name.endsWith('_ms') || name.endsWith('_status'));

/** Where a probe name comes from, given the tenant's recorded probe names. */
export function probeSourceOf(name: string, recorded: ReadonlySet<string>): ProbeSource {
  if (recorded.has(name)) return 'recorded';
  return isRequestProbe(name) ? 'request' : 'declared';
}

/** What a recorded probe reads over recent sessions, before anyone saves it (and as saved). Numbers only. */
export interface ProbePreview {
  sessions_scanned: number;
  /** Sessions where the probe read at least one value. */
  sessions_with_value: number;
  snapshots: number;
  values: { min: number; median: number; max: number } | null;
  /** Routes it was read on. */
  routes: string[];
  /** A few sessions it read, for replay links: ids, times and the number, no page content. */
  samples: { session_id: string; event_time: number; route: string; value: number }[];
  window: { from: number; to: number };
  at: number;
}

/**
 * Hot copy of one recorded probe (Firestore `probes/{tenant}__{name}`). Written by the agent service only;
 * the processor reads the active ones. The bitemporal record is a `rules` table row of kind `probe` per version.
 */
export interface ProbeDoc {
  v: 1;
  tenant_id: string;
  name: string;
  spec: RecordedProbeSpec;
  /** Who proposed it: a merchant on the Rules tab, or the agent (approved by a person with its rule). */
  source: 'merchant' | 'agent';
  status: 'active' | 'disabled';
  version: number;
  approved_by: string;
  /** The rule it was approved with (agent proposals), else null. */
  rule_id: string | null;
  preview: ProbePreview | null;
  created_at: number;
  updated_at: number;
  synthetic: true;
}
