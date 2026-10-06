---
name: bitemporal-rescan
description: Work on anything involving valid time and transaction time (event_time, ingest_time, valid_from/valid_to, recorded_from/recorded_to, rule_version), versioned findings, as-of queries, or the retroactive re-scan of past sessions with a new or changed rule.
---

# Bitemporal storage and retroactive re-scan

Two clocks on every row. Valid time is when it happened in the user's browser, corrected for clock skew. Transaction time is when our system learned it or wrote that version.

| Table | Valid time | Transaction time |
| --- | --- | --- |
| signals | `event_time` | `ingest_time` |
| business_events | `event_time` | `ingest_time` |
| findings | `valid_from`, `valid_to` | `recorded_from`, `recorded_to` |
| rules | n/a | `recorded_at` (plus `version`) |

## Rules

- Never overwrite a finding. A change writes a new version row with a later `recorded_from`.
- Preferred pattern: keep the table purely append-only and derive the close of each version in a view:

```sql
CREATE OR REPLACE VIEW findings_versions AS
SELECT f.*,
       LEAD(recorded_from) OVER (PARTITION BY tenant_id, finding_id ORDER BY recorded_from) AS recorded_to_derived
FROM findings AS f;
```

- If a stored `recorded_to` column is kept, close the previous version with a single MERGE and touch no other column. BigQuery can refuse DML on rows still in the streaming buffer, so write findings through batch loads or INSERT DML (check current BigQuery docs).
- Skew correction: `event_time` = client time adjusted by the difference between `collector_received_at` and `client_sent_at`.
- Every query includes `tenant_id`, a partition filter on event date, and a maximum bytes billed setting.

## As-of query (what did we believe at T about the window [A, B))

```sql
SELECT finding_id, severity, revenue_at_risk_minor
FROM findings_versions
WHERE tenant_id = @tenant
  AND valid_from < @window_end
  AND (valid_to IS NULL OR valid_to > @window_start)
  AND recorded_from <= @as_of
  AND (recorded_to_derived IS NULL OR recorded_to_derived > @as_of);
```

- "When did users hit this?" filters valid time only.
- "What did we know then?" filters transaction time only.
- "What did we know then about then?" filters both. The difference between the as-of answer and the current answer is the set of bugs the old rules missed.

## Re-scan flow

1. A rule is created or edited, writing a new `rules` row and version. Run a dry run over the last 1,000 sessions and show hit rate and samples.
2. After human approval, start a Cloud Run Job over the chosen window (30 days by default).
3. Write new signals with the new `rule_version`, the original `event_time`, and `ingest_time` = now.
4. The clusterer writes new finding versions. Tag each finding as known at the time or found later, based on whether any earlier version existed.
5. The dashboard shows sessions affected since the bug began and the revenue at risk.

## Two execution paths

- Fast path: rules over signals, probe values, or the Parquet copy of the normalized stream in Cloud Storage. Minutes.
- Rebuild path: a rule needing a selector nobody probed. Replay raw chunks in headless Chromium with the rrweb replayer. Slow and costly, so cap it per run and treat it as phase 2.

## Tests

- Late-arriving events: `ingest_time` far after `event_time` must keep the right valid time.
- Rule change: a new `rule_version` produces new signals and new finding versions; the old versions still answer as-of queries correctly.
- As-of before and after the re-scan return different sets, and the difference equals the seeded retro bug.
