import { z } from 'zod';

/**
 * Contract between the browser SDK and the normalizer: rrweb Custom events (type 5) whose
 * `data.tag` is one of CUSTOM_TAGS carry the non-DOM facts detectors need. Payloads hold no bodies,
 * headers, query strings, or free text typed by the user.
 */
export { CUSTOM_TAGS, FLAG_TAG_PREFIX } from './tags.js';

export const NetPayload = z.object({
  phase: z.enum(['start', 'end']).default('end'),
  method: z.string().max(16),
  /** Route template of the request URL, with no query string. */
  route: z.string().max(512),
  /** HTTP status (phase "end"); 0 for a network failure or timeout. */
  status: z.int().min(0).max(599).default(0),
  /** Phase "end" only. */
  duration_ms: z.number().nonnegative().default(0),
});
export type NetPayload = z.infer<typeof NetPayload>;

export const ErrorPayload = z.object({
  kind: z.enum(['error', 'unhandledrejection']),
  /** Normalized error signature (type plus first stack frame), never the raw message. */
  signature: z.string().max(256),
});
export type ErrorPayload = z.infer<typeof ErrorPayload>;

/**
 * A snapshot of every registered probe, emitted when the DOM under the probes settles and the numbers
 * changed. Values are parsed in the browser: money in minor units, counts as integers. No text.
 */
export const ProbePayload = z.object({
  values: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.array(z.number().finite()).max(100)),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});
export type ProbePayload = z.infer<typeof ProbePayload>;

export const NavPayload = z.object({
  reason: z.enum(['spa', 'unload']),
  route: z.string().max(512).optional(),
});
export type NavPayload = z.infer<typeof NavPayload>;
