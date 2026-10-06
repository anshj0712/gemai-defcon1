import { z } from 'zod';

/** Identifiers end up in Cloud Storage paths and Firestore document ids, so keep them to a safe alphabet. */
export const SAFE_ID = /^[A-Za-z0-9_-]{8,128}$/;
export const TENANT_ID = /^[a-z0-9][a-z0-9_-]{1,62}$/;

export const MAX_EVENTS_PER_BATCH = 20_000;
export const MAX_BUSINESS_EVENTS_PER_BATCH = 200;

/**
 * One rrweb event. The collector treats events as opaque apart from `type` and `timestamp`;
 * every other field passes through untouched (after scrubbing).
 */
export const RrwebEvent = z.looseObject({
  type: z.int().min(0).max(7),
  timestamp: z.number().nonnegative(),
});
export type RrwebEvent = z.infer<typeof RrwebEvent>;

/** An explicit commerce event emitted by the host site (cart viewed, checkout started, order placed). */
export const BusinessEvent = z.object({
  name: z.string().min(1).max(64),
  value_minor: z.int().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  /** Client epoch ms. Defaults to the batch's client_ts_end when absent. */
  ts: z.number().nonnegative().optional(),
});
export type BusinessEvent = z.infer<typeof BusinessEvent>;

const EnvelopeFields = z.object({
  site_key: z.string().min(8).max(128),
  session_id: z.string().regex(SAFE_ID),
  seq: z.int().min(0),
  client_ts_start: z.number().nonnegative(),
  client_ts_end: z.number().nonnegative(),
  client_sent_at: z.number().nonnegative(),
  sdk_version: z.string().min(1).max(32),
  release: z.string().min(1).max(128),
  /** Share of sessions shipped by the SDK's sampler (1 = every session). Used to re-weight counts. */
  sample_rate: z.number().gt(0).lte(1).optional(),
  page: z.object({
    route: z.string().min(1).max(512),
    url_path: z.string().min(1).max(2048),
  }),
  events: z.array(RrwebEvent).max(MAX_EVENTS_PER_BATCH),
  business_events: z.array(BusinessEvent).max(MAX_BUSINESS_EVENTS_PER_BATCH).default([]),
});

const tsOrdered = (e: { client_ts_start: number; client_ts_end: number }) => e.client_ts_end >= e.client_ts_start;
const tsOrderedIssue = { message: 'client_ts_end must not be before client_ts_start', path: ['client_ts_end'] };

/** One SDK batch, as POSTed to the collector (optionally gzipped). */
export const IngestEnvelope = EnvelopeFields.refine(tsOrdered, tsOrderedIssue);
export type IngestEnvelope = z.infer<typeof IngestEnvelope>;

/**
 * What the collector writes to Cloud Storage: the scrubbed envelope without its site key, plus the
 * tenant it resolved to and the collector's receive time. Immutable once written.
 */
export const StoredChunk = z.object({
  v: z.literal(1),
  tenant_id: z.string().regex(TENANT_ID),
  collector_received_at: z.number().nonnegative(),
  envelope: EnvelopeFields.omit({ site_key: true }).refine(tsOrdered, tsOrderedIssue),
});
export type StoredChunk = z.infer<typeof StoredChunk>;
