import { z } from 'zod';

/**
 * Append-only rows (ARCHITECTURE.md section 3). Timestamps are epoch ms in code and TIMESTAMP in
 * BigQuery; JSON columns are plain objects in code. Column specs live in ./bigquery.ts.
 */

const ms = z.number();
const json = z.record(z.string(), z.unknown());

export const RawChunkRow = z.object({
  tenant_id: z.string(),
  session_id: z.string(),
  seq: z.int(),
  gcs_uri: z.string(),
  bytes: z.int(),
  event_count: z.int(),
  event_time_start: ms,
  event_time_end: ms,
  ingest_time: ms,
  client_sent_at: ms,
  collector_received_at: ms,
  release: z.string(),
  route: z.string(),
  sdk_version: z.string(),
  sample_rate: z.number().nullable(),
});
export type RawChunkRow = z.infer<typeof RawChunkRow>;

export const SignalRow = z.object({
  signal_id: z.string(),
  tenant_id: z.string(),
  session_id: z.string(),
  seq: z.int(),
  detector: z.string(),
  detector_version: z.string(),
  rule_version: z.string(),
  fingerprint: z.string(),
  route: z.string(),
  element_selector: z.string().nullable(),
  release: z.string(),
  evidence: json,
  event_time: ms,
  ingest_time: ms,
});
export type SignalRow = z.infer<typeof SignalRow>;

export const BusinessEventRow = z.object({
  tenant_id: z.string(),
  session_id: z.string(),
  seq: z.int(),
  name: z.string(),
  value_minor: z.int().nullable(),
  currency: z.string().nullable(),
  event_time: ms,
  ingest_time: ms,
});
export type BusinessEventRow = z.infer<typeof BusinessEventRow>;

export const RuleRow = z.object({
  tenant_id: z.string(),
  rule_id: z.string(),
  version: z.int(),
  kind: z.enum(['builtin', 'generated']),
  definition: json,
  created_by: z.string(),
  recorded_at: ms,
});
export type RuleRow = z.infer<typeof RuleRow>;

export const FindingRow = z.object({
  tenant_id: z.string(),
  finding_id: z.string(),
  fingerprint: z.string(),
  severity: z.string(),
  revenue_at_risk_minor: z.int(),
  currency: z.string(),
  affected_sessions: z.int(),
  summary: z.string(),
  evidence_refs: json,
  rule_version: z.string(),
  model_version: z.string().nullable(),
  prompt_hash: z.string().nullable(),
  valid_from: ms,
  valid_to: ms.nullable(),
  recorded_from: ms,
  recorded_to: ms.nullable(),
});
export type FindingRow = z.infer<typeof FindingRow>;

export const ROW_SCHEMAS = {
  raw_chunks: RawChunkRow,
  signals: SignalRow,
  business_events: BusinessEventRow,
  rules: RuleRow,
  findings: FindingRow,
} as const;

export type TableName = keyof typeof ROW_SCHEMAS;

export interface RowTypes {
  raw_chunks: RawChunkRow;
  signals: SignalRow;
  business_events: BusinessEventRow;
  rules: RuleRow;
  findings: FindingRow;
}
