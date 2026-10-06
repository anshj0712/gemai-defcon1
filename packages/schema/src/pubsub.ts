import { z } from 'zod';
import { SAFE_ID, TENANT_ID } from './envelope.js';

/**
 * Message on the `events.raw` topic. Metadata and a storage URI only: the events themselves never
 * travel through Pub/Sub. Ordering key = session_id.
 */
export const RawChunkMessage = z.object({
  v: z.literal(1),
  tenant_id: z.string().regex(TENANT_ID),
  session_id: z.string().regex(SAFE_ID),
  seq: z.int().min(0),
  /** gs://bucket/path in gcp mode, local://bucket/path in local mode. */
  gcs_uri: z.string().min(1),
  bytes: z.int().nonnegative(),
  event_count: z.int().nonnegative(),
  client_ts_start: z.number(),
  client_ts_end: z.number(),
  client_sent_at: z.number(),
  collector_received_at: z.number(),
  release: z.string(),
  route: z.string(),
  sdk_version: z.string(),
  sample_rate: z.number().gt(0).lte(1).optional(),
});
export type RawChunkMessage = z.infer<typeof RawChunkMessage>;

/** Body of a Pub/Sub push request (https://cloud.google.com/pubsub/docs/push). */
export const PubSubPushBody = z.looseObject({
  message: z.looseObject({
    data: z.string(),
    attributes: z.record(z.string(), z.string()).optional(),
    messageId: z.string().optional(),
    publishTime: z.string().optional(),
    orderingKey: z.string().optional(),
  }),
  subscription: z.string(),
  deliveryAttempt: z.int().optional(),
});
export type PubSubPushBody = z.infer<typeof PubSubPushBody>;
