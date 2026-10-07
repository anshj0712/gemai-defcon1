import type { TableName } from './rows.js';

/**
 * BigQuery column specs for the append-only tables. Infra creates tables from these, and the
 * warehouse adapter uses them to convert rows (epoch ms -> TIMESTAMP, object -> JSON).
 */

export type BqType = 'STRING' | 'INT64' | 'FLOAT64' | 'BOOL' | 'TIMESTAMP' | 'JSON';

export interface BqField {
  name: string;
  type: BqType;
  mode: 'REQUIRED' | 'NULLABLE';
  description?: string;
}

export interface BqTableSpec {
  name: TableName;
  description: string;
  fields: BqField[];
  /** DAY partitioning column. */
  partitionField: string;
  clusterFields: string[];
}

const req = (name: string, type: BqType, description?: string): BqField => ({ name, type, mode: 'REQUIRED', description });
const opt = (name: string, type: BqType, description?: string): BqField => ({ name, type, mode: 'NULLABLE', description });

export const BQ_TABLES: Record<TableName, BqTableSpec> = {
  raw_chunks: {
    name: 'raw_chunks',
    description: 'One row per stored SDK batch. Index into Cloud Storage; never query chunk contents from BigQuery.',
    partitionField: 'event_time_start',
    clusterFields: ['tenant_id', 'session_id'],
    fields: [
      req('tenant_id', 'STRING'),
      req('session_id', 'STRING'),
      req('seq', 'INT64'),
      req('gcs_uri', 'STRING'),
      req('bytes', 'INT64', 'Stored (gzipped) size'),
      req('event_count', 'INT64'),
      req('event_time_start', 'TIMESTAMP', 'Valid time, skew-corrected'),
      req('event_time_end', 'TIMESTAMP', 'Valid time, skew-corrected'),
      req('ingest_time', 'TIMESTAMP', 'Transaction time'),
      req('client_sent_at', 'TIMESTAMP'),
      req('collector_received_at', 'TIMESTAMP'),
      req('release', 'STRING'),
      req('route', 'STRING'),
      req('sdk_version', 'STRING'),
      opt('sample_rate', 'FLOAT64', 'SDK sampling rate for this session; re-weight counts by 1/sample_rate'),
    ],
  },
  signals: {
    name: 'signals',
    description: 'One row per detector hit. Append-only; duplicates from redelivery share signal_id (see signals_dedup).',
    partitionField: 'event_time',
    clusterFields: ['tenant_id', 'session_id'],
    fields: [
      req('signal_id', 'STRING', 'Deterministic id; the streaming insertId'),
      req('tenant_id', 'STRING'),
      req('session_id', 'STRING'),
      req('seq', 'INT64', 'Chunk the triggering event arrived in'),
      req('detector', 'STRING'),
      req('detector_version', 'STRING'),
      req('rule_version', 'STRING'),
      req('fingerprint', 'STRING'),
      req('route', 'STRING'),
      opt('element_selector', 'STRING', 'Normalized selector'),
      req('release', 'STRING'),
      req('evidence', 'JSON'),
      req('event_time', 'TIMESTAMP', 'Valid time'),
      req('ingest_time', 'TIMESTAMP', 'Transaction time'),
    ],
  },
  business_events: {
    name: 'business_events',
    description: 'One row per commerce event emitted by the host site.',
    partitionField: 'event_time',
    clusterFields: ['tenant_id', 'session_id'],
    fields: [
      req('tenant_id', 'STRING'),
      req('session_id', 'STRING'),
      req('seq', 'INT64'),
      req('name', 'STRING'),
      opt('value_minor', 'INT64'),
      opt('currency', 'STRING'),
      req('event_time', 'TIMESTAMP', 'Valid time'),
      req('ingest_time', 'TIMESTAMP', 'Transaction time'),
    ],
  },
  rules: {
    name: 'rules',
    description: 'One row per rule version (builtin or generated).',
    partitionField: 'recorded_at',
    clusterFields: ['tenant_id', 'rule_id'],
    fields: [
      req('tenant_id', 'STRING'),
      req('rule_id', 'STRING'),
      req('version', 'INT64'),
      req('kind', 'STRING', 'builtin | generated'),
      req('definition', 'JSON'),
      req('created_by', 'STRING'),
      req('recorded_at', 'TIMESTAMP', 'Transaction time'),
    ],
  },
  findings: {
    name: 'findings',
    description: 'One row per finding version. Never updated in place; see findings_versions for recorded_to.',
    partitionField: 'valid_from',
    clusterFields: ['tenant_id', 'fingerprint'],
    fields: [
      req('tenant_id', 'STRING'),
      req('finding_id', 'STRING'),
      req('fingerprint', 'STRING'),
      req('severity', 'STRING'),
      req('revenue_at_risk_minor', 'INT64'),
      req('currency', 'STRING'),
      req('affected_sessions', 'INT64'),
      req('summary', 'STRING'),
      req('evidence_refs', 'JSON'),
      req('rule_version', 'STRING'),
      opt('model_version', 'STRING'),
      opt('prompt_hash', 'STRING'),
      opt('cluster_id', 'STRING', 'The issue this finding scores'),
      opt('title', 'STRING'),
      opt('status', 'STRING', 'open | suspect'),
      opt('score', 'FLOAT64', 'Ranking score: revenue at risk x tier weight x modifiers'),
      opt('input_hash', 'STRING', 'Hash of everything that went into this version'),
      opt('details', 'JSON', 'Agent outputs, priority decision, revenue inputs, run log'),
      req('valid_from', 'TIMESTAMP', 'Valid time'),
      opt('valid_to', 'TIMESTAMP', 'Valid time'),
      req('recorded_from', 'TIMESTAMP', 'Transaction time'),
      opt('recorded_to', 'TIMESTAMP', 'Transaction time; prefer the view-derived value'),
    ],
  },
};

/** Views over the append-only tables. `{dataset}` is replaced with the fully qualified dataset. */
export const BQ_VIEWS: Record<string, string> = {
  findings_versions: `
SELECT f.*,
       LEAD(recorded_from) OVER (PARTITION BY tenant_id, finding_id ORDER BY recorded_from) AS recorded_to_derived
FROM \`{dataset}.findings\` AS f`,
  // event_time is in the window partition (it is fixed per signal_id) so that callers' filters on
  // the partition column still prune through the view.
  signals_dedup: `
SELECT * EXCEPT (rn) FROM (
  SELECT s.*, ROW_NUMBER() OVER (PARTITION BY tenant_id, event_time, signal_id ORDER BY ingest_time) AS rn
  FROM \`{dataset}.signals\` AS s
)
WHERE rn = 1`,
};
