# Churn Preventer Agent: Architecture & Build Plan

Snapshot of the plan written on 23 Sep 2026. From now on this file is the canonical copy for the repo; update it when interfaces, tables, or behavior change. Non-negotiable rules live in `AGENTS.md`.

## 1. Thesis and MVP scope

We build a checkout-focused pipeline that finds friction and silent data bugs in live rrweb sessions, then ranks them by revenue at risk. Frustration tools already flag rage clicks. Our wedge is what they miss: business-rule violations (a cart total that does not match its line items) and retroactive detection (ship a new rule, re-scan the past 30 days).

Working target for the demo: a bug hit in the browser appears as a ranked finding on the dashboard in under 60 seconds. This is a design target, not a measured figure.

In scope for the MVP:

- A browser SDK that wraps rrweb, masks sensitive fields, and ships events in compressed batches.
- A GCP ingest and processing pipeline (Cloud Run, Pub/Sub, Cloud Storage, BigQuery).
- Four pluggable detectors: rage click, dead click, invariant check (cart total vs line items), and JS error or failed-request correlation.
- Cross-session clustering, then Gemini triage and root-cause hypotheses on clusters only.
- A bitemporal findings store with a retroactive re-scan when a rule changes.
- A dashboard with a findings feed, embedded replay, and revenue-at-risk estimates.

Deliberately out of scope: heatmaps, funnels, and general product analytics; mobile SDKs and multi-tenant billing; auto-fixing customer code; self-serve onboarding beyond pasting one script tag.

We target the Retail & Commerce theme and keep every feature tied to the checkout flow.

## 2. System architecture

Raw rrweb data is stored cheaply and never queried directly; a tiered pipeline turns it into signals, clusters, and ranked findings, and only the last tier touches an LLM.

```mermaid
flowchart LR
  A["Browser SDK<br/>rrweb + masking"] -->|"gzip batches"| B["Collector<br/>Cloud Run"]
  B --> C[("Raw chunks<br/>Cloud Storage")]
  B --> D["Pub/Sub<br/>events.raw"]
  D --> E["Processor<br/>detectors, Cloud Run"]
  E <--> F[("Hot session state<br/>Firestore")]
  E --> G[("BigQuery<br/>signals, bitemporal")]
  E -->|"signals topic"| H["Clusterer<br/>fingerprints"]
  H --> I["Agent service<br/>Gemini via ADK"]
  I --> J[("Findings<br/>BigQuery + Firestore")]
  J --> K["Dashboard + API<br/>Cloud Run / Firebase"]
  C -.->|"replay"| K
```

| Component | Responsibility | Scales by |
| --- | --- | --- |
| Browser SDK | Wrap rrweb, mask inputs, detect cheap local triggers, batch and compress, flush with sendBeacon on unload | Client-side sampling |
| Collector (Cloud Run) | Validate site key, assign chunk sequence, write raw chunk to Cloud Storage, publish a small envelope to Pub/Sub | Concurrent requests per instance |
| Pub/Sub (events.raw) | Decouple ingest from processing; ordering key = session_id | Partitioned throughput, backlog buffer |
| Processor (Cloud Run) | Rebuild state per chunk, run every registered detector, emit signals; keep a short session tail in Firestore | Instances subscribed to the topic |
| BigQuery | Append-only signals and findings with event time, ingest time, and rule version | Partition by event date, cluster by tenant and session |
| Clusterer | Group signals across sessions into issues: element symptoms by route and selector, data-rule violations by rule id (section 4) | Push subscription on the signals topic; one transaction per signal |
| Agent service | Gemini triage, root-cause hypothesis, ranking against the rule set, rule authoring | Runs per cluster, not per session |
| Dashboard + API | Findings feed, replay player reading raw chunks, revenue at risk | Static hosting plus a thin API |

Design rules:

- Every stage is idempotent, keyed by session_id and chunk sequence, so Pub/Sub redelivery is harmless.
- Raw data is immutable. Anything derived can be recomputed, which is what makes retroactive re-scan possible.
- The LLM sees structured evidence (signals, selectors, DOM diffs, a few screenshots), never raw rrweb streams.

## 3. Data model

Five append-only tables carry the record: a raw-chunk index, signals, business events, rules, and findings, with two clocks on every row so past states can be reconstructed.

Ingest envelope (one SDK batch; the rrweb events stay opaque to the collector):

```json
{
  "site_key": "pk_live_...",
  "session_id": "s_8f2c...",
  "seq": 42,
  "client_ts_start": 1790000000000,
  "client_ts_end": 1790000004800,
  "client_sent_at": 1790000004900,
  "sdk_version": "0.3.1",
  "release": "git:a1b2c3d",
  "page": { "route": "/checkout", "url_path": "/checkout" },
  "events": [ /* rrweb events: FullSnapshot, IncrementalSnapshot, Meta, Custom */ ],
  "business_events": [ { "name": "cart_viewed", "value_minor": 129900, "currency": "INR" } ]
}
```

The `release` field ties a finding to a deploy. Business events are explicit custom events the site emits (cart viewed, checkout started, order placed); they feed revenue at risk.

Additions implemented in `packages/schema` (25 Sep):

- `sample_rate` (optional, 0 to 1) on the envelope records the SDK sampler's rate, so counts can be re-weighted (AGENTS rule 9). It is stored on `raw_chunks`.
- Each business event may carry `ts` (client epoch ms). It defaults to the batch's `client_ts_end`.
- `session_id` is restricted to `[A-Za-z0-9_-]{8,128}` because it becomes part of storage paths and document ids.
- The collector stores `{v, tenant_id, collector_received_at, envelope}` gzipped at `raw/{tenant}/{session}/{seq:08}.json.gz`. The stored envelope is scrubbed and has no site key. Nothing overwrites it: the write uses `ifGenerationMatch: 0`.
- The `events.raw` message is metadata only: tenant, session, seq, `gcs_uri`, sizes, the three client clocks, `collector_received_at`, release, route, and SDK version. Its ordering key is `session_id`.

| Table | Grain | Key columns |
| --- | --- | --- |
| raw_chunks | One row per stored batch | tenant_id, session_id, seq, gcs_uri, bytes, event_time_start, event_time_end, ingest_time |
| signals | One row per detector hit | signal_id, tenant_id, session_id, detector, detector_version, rule_version, fingerprint, route, element_selector, evidence (JSON), event_time, ingest_time |
| business_events | One row per commerce event | tenant_id, session_id, name, value_minor, currency, event_time, ingest_time |
| rules | One row per rule version | rule_id, version, kind (builtin or generated), definition (JSON), created_by, recorded_at |
| findings | One row per finding version | finding_id, fingerprint, severity, revenue_at_risk_minor, affected_sessions, summary, evidence_refs, rule_version, model_version, valid_from, valid_to, recorded_from, recorded_to |

The two clocks:

- Valid time (`event_time`, `valid_from`, `valid_to`): when it happened in the user's browser, corrected for clock skew by comparing `client_sent_at` with the collector's receive time.
- Transaction time (`ingest_time`, `recorded_from`, `recorded_to`): when our system learned it or wrote that version.

Findings are never updated in place. A change writes a new row, and the previous version is closed. Implementation note: `recorded_to` may be derived in a view with `LEAD(recorded_from)` so the table stays purely append-only; see the `bitemporal-rescan` skill.

As built, column specs live in `packages/schema/src/bigquery.ts`, and a test keeps them in step with the zod row types. Beyond the table above:

- `raw_chunks` also stores `event_count`, `client_sent_at`, `collector_received_at`, `release`, `route`, `sdk_version`, and `sample_rate`.
- `signals` also stores `seq` (the chunk the triggering event arrived in) and `release`.
- Two views exist:
  - `findings_versions` derives `recorded_to` with `LEAD`.
  - `signals_dedup` removes the rare duplicate that streaming insert can leave after a retry. `signal_id` is deterministic and doubles as the streaming insertId.
- Writes use BigQuery streaming insert (`insertAll` with insertIds) behind a `Warehouse` port. The Storage Write API can replace it behind the same port.

Live issues (Firestore, implemented 6 Oct). The clusterer keeps one document per issue in `clusters/{tenant}__{cluster_id}`. The document holds the queryable fields `tenant_id`, `cluster_id`, `kind`, `last_seen` and `updated_at`, plus the whole `Cluster` (`packages/schema/src/clusters.ts`) as gzipped JSON:

- symptom counts per detector
- signal and session counts, and up to 5,000 session ids
- releases, fingerprints, error signatures, first and last seen
- the five newest evidence items, one per session where possible

`clustered_signals/{tenant}__{signal_id}` markers, with a TTL on `expires_at` (8 days), make each signal count once under redelivery. Issues are a hot, derived view like the session tail: they are not the bitemporal record and can be rebuilt from `signals` (rule 3). Versioned findings in BigQuery start in Phase 3 and will reference a cluster's fingerprints.

## 4. Detection engine

Detectors are small plugins that read a normalized event stream, not raw rrweb, so rage click detection is one module among several and adding another detector touches no other code.

The processor first converts rrweb events into a normalized stream: clicks (time, target selector, position), DOM mutation counts per target, navigations, inputs, plus custom events from the SDK for network calls, JS errors, and probe values. Every detector implements one interface:

```ts
interface Detector {
  id: string;              // "rage_click"
  version: string;         // bumped on any logic change
  params: Record<string, number | string>;
  run(ctx: SessionContext, chunk: NormalizedChunk): Signal[];
}

interface Signal {
  detector: string;
  fingerprint: string;     // hash(detector, route template, normalized selector, error signature)
  eventTime: number;       // valid time, ms
  evidence: {              // small, structured, replayable
    sessionId: string; seq: number; tStart: number; tEnd: number;
    selector?: string; values?: Record<string, unknown>;
  };
}
```

| Detector | Fires when (starting defaults, to be tuned) | Covers |
| --- | --- | --- |
| rage_click | 3 or more clicks on the same element within 1.5 s and 40 px | Users hammering a broken control |
| dead_click | Click on an interactive element with no DOM mutation, navigation, or request within 800 ms | Controls that do nothing |
| response_decay | An element responded to its first k clicks, then 3 or more consecutive clicks get no response | The button that stops registering after 5 clicks |
| invariant_check | A rule over probe values is violated beyond tolerance (for example cart total differs from the sum of line items by more than 1 minor unit) | Silent data bugs with no user frustration signal |
| error_correlation | A JS error, unhandled rejection, or 4xx/5xx/timeout occurs within 2 s before another signal | Attaches root-cause evidence and raises severity |

These thresholds are our own starting values, not industry standards; expose them as `params` per tenant.

Probes make invariants cheap and re-scannable. A tenant registers probe selectors once (cart total, line-item price, quantity, discount). The SDK emits their text values as custom events whenever the DOM under them changes. Invariants are then pure functions over probe values: no DOM rebuild, and any new rule over already-captured probes can be re-scanned from BigQuery alone. A rule that needs a selector nobody probed goes to the slower rebuild path (section 6).

Fingerprints are what let 400 sessions collapse into one finding. Normalize selectors before hashing: strip generated ids, hashed class names, and positional indexes, and replace dynamic route segments with templates.

Implementation notes (25 Sep):

- **SDK event contract.** Non-DOM facts arrive as rrweb Custom events whose `data.tag` is one of the following (see `packages/schema/src/custom-events.ts`):
  - `cp.net`: phase `start` at the call, and `end` with status and duration. There is no URL query, header, or body.
  - `cp.error`: a normalized signature, never the raw message.
  - `cp.probe`: a snapshot of every registered probe, `{values: {name: number[]}, currency}`, sent whenever any of them changes. Money is parsed to minor units in the browser; the text never leaves it.
  - `cp.nav`: an SPA route change, or `unload` on pagehide before the final flush.

  dead_click needs the `start` phase: without it, a click that triggers a slow request would look dead.
- **DOM index in the session tail.** rrweb clicks reference node ids from an earlier full snapshot. The normalizer therefore carries a compact index across chunks:
  - interactive elements, with their node-local selector and disabled flag
  - aliases from descendants to their nearest interactive ancestor, so a click on a `<span>` inside a `<button>` resolves to the button

  It is rebuilt on each FullSnapshot, updated by mutations, and capped at 5,000 entries.
- **dead_click v1** (`windowMs` 800, inclusive):
  - **Interactive targets:** `button`, `a[href]`, `summary`, submit/button/checkbox/radio inputs, and button-like roles.
  - **Excluded targets:** disabled controls, text inputs, and `select`, which opens native UI with no DOM change.
  - **Responses:** a mutation, navigation, request start, or input change within the window.
  - **Decision horizon:** a click is decided only in the chunk whose horizon (skew-corrected `client_ts_end`) first covers `click.t + windowMs`. The session tail carries the previous horizon, so each click is decided exactly once, even when its response lands in the next batch.
- **Rule versions for builtin detectors.** `rule_version` is a hash of the detector's effective params (defaults merged with tenant overrides from `DETECTOR_PARAMS`), so a threshold change produces new signal versions.
- **Ordering and gaps.** The processor serializes chunks per session. A chunk that arrives ahead of a missing earlier `seq` is nacked for up to `GAP_WAIT_ATTEMPTS` deliveries, then processed anyway so one lost batch cannot stall a session. A chunk at or behind the tail is indexed in `raw_chunks` without detection; re-scan can recover it from raw.

Implementation notes (6 Oct, Phase 2). Every detector below is a pure function in `packages/detectors`, with tests. Thresholds are `params` and can be overridden per tenant through `DETECTOR_PARAMS`.

| Detector (version) | As built |
| --- | --- |
| dead_click (1.3.0) | As above, with the response rule below. |
| rage_click (1.1.0) | 3+ clicks on one element, each within 1.5 s of the previous and 40 px of the first, with 3 inside some 1.5 s window. At least one click must have failed: no response within 800 ms, or an error or failed request within 2 s (`requireFailure`; 0 restores the textbook rule). The burst is decided once its last click + 2 s is covered by a horizon. |
| response_decay (1.1.0) | Per route and selector: 2+ answered clicks, then 3+ unanswered in a row. Fires once per streak. Counts persist across chunks in `SessionTail.detector_state`. |
| invariant_check (1.0.0) | Evaluates each probe snapshot against the tenant's rules (built-in: `cart_total_matches_lines`, cart total = sum of line totals − discount, within 1 minor unit). Reports a given rule once per distinct set of probe values. `rule_version` is `<rule_id>@<version>`. |
| error_correlation (1.0.0) | A second pass over this chunk's other signals. It attaches the latest JS error or failed request in the 2 s before a signal (or during it), inheriting that signal's route and element, so the error lands in the same issue as its symptom. |

- **What counts as a response** (dead_click, rage_click, response_decay; `responseCheck` in `response.ts`): a mutation, navigation, request, or change on the clicked control itself, inside the window and before the user's next click on a different element.
  - Responses after a click elsewhere belong to that click: pressing Checkout right after a dead button navigates, but that does not answer the dead button.
  - A change on another field does not count either. With `sampling.input: 'last'`, rrweb records a text field's change when it loses focus, which is the moment the next button is pressed.
  - The simulator found both false negatives; dead_click went from 1.2.0 to 1.3.0.
- **Two-pass registry.** Primary detectors run first. Correlators (`phase: 'correlate'`) then see the primary signals. A detector that throws is isolated and logged; the others still run.
- **Stateful detectors.** `run` may return `{signals, state}`; the processor stores the state per detector in the session tail and passes it back on the next chunk.
- **Rules** (`InvariantRuleSchema` in `packages/schema/src/rules.ts`) are declarative JSON:
  - `requires`: the probes the rule needs;
  - `assert`: `{left, op: eq | lte | gte, right, tolerance_minor}`, where both sides are expressions over probe values (`probe`, `sum`, `count`, `const`, `add`, `sub`, `mul`, `abs`);
  - optional `routes` and a `highlight_probe` for the replay.

  Tenants add rules through `INVARIANT_RULES`. This is the format the Phase 4 rule author will emit.
- **Issue keys** (the clusterer, `apps/clusterer/src/cluster.ts`): one broken thing produces several symptoms with different per-detector fingerprints, so issues are keyed more coarsely.
  - Element signals: tenant + route + normalized selector.
  - Invariant signals, and errors correlated with them: tenant + rule id.

  A tenant is capped at `MAX_CLUSTERS_PER_TENANT` issues (500); further new issues are refused and logged.

## 5. Agent layer (Gemini + ADK)

Deterministic code decides what is a finding and how much it is worth; Gemini explains it, verifies it visually, and writes new rules. That split keeps rankings reproducible and puts the Gen AI where it adds the most.

Build it with the Agent Development Kit, whose TypeScript 2.0 release has graph workflows that mix deterministic steps and LLM steps, so the whole stack can stay in one language. Deploying is `npx adk deploy cloud_run` with the agent exported as `rootAgent` in `agent.ts`. As of 23 Sep 2026 the GA Gemini models include `gemini-3.8-flash` and the cheaper `gemini-3.5-flash-lite`; model IDs turn over roughly monthly, so read them from config.

| Agent | Model tier | Input | Output |
| --- | --- | --- | --- |
| Triage | flash-lite | Cluster summary: fingerprint, count, route, top selectors, release, 3 to 5 sample evidence items | JSON: title, category, confidence, likely cause, repro steps |
| Root cause and verify | flash (reasoning, vision) | Triage output plus tool calls: session samples, DOM diff at time t, error context, screenshot at time t, release diff | JSON: cause hypothesis, visual confirmation yes or no, evidence ids cited |
| Rule author | flash | A merchant sentence such as "cart total must equal line items minus discount plus shipping" | Rule JSON (probes and invariant), dry-run precision on recent sessions, then human approval |
| Ranker | Deterministic core with a bounded LLM step | Enriched finding and the priority rule set | Score, tier, and the priority rule ids that applied |

Ranking against a rule set. The priority rule set is versioned data in the `rules` table, for example: checkout and payment blockers outrank pricing errors, pricing errors outrank browse-page friction, and a regression appearing right after a release gets a multiplier. Gemini classifies each finding into these buckets and cites the rule ids. The score itself is computed in code:

```latex
\text{RaR} = N_{\text{affected}} \times \bar{V}_{\text{cart}} \times \left(a_{\text{affected}} - a_{\text{baseline}}\right)
```

N is affected sessions that had a cart, V is their average cart value, and a is the checkout abandonment rate for affected sessions versus a baseline of unaffected sessions on the same route. Using the difference, not the raw abandonment, avoids claiming revenue that would have been lost anyway. The LLM may move a finding by at most one severity tier, and only with a cited rule id.

Grounding and guardrails:

- Every claim in an LLM output must cite evidence ids we supplied; a validator rejects outputs that cite unknown ids.
- Outputs use structured JSON schemas, never free text parsed with regex.
- The visual check is the false-positive filter: render the frame from the replay at the signal time and ask Gemini whether the on-screen state actually shows the defect.
- Each finding stores prompt hash, model id, and rule version so any verdict can be reproduced later.

### Implemented (8 Oct, Phase 3): the agent service

`apps/agent` is a Cloud Run service (local port 8084) that turns issues into versioned, ranked findings. Each pass, per tenant (`AGENT_TENANTS`), it reads the live issues, picks the ones due (new, or not re-scored for `AGENT_RESCORE_MS`; new and biggest first, at most `AGENT_MAX_PER_PASS`), and runs this pipeline (`src/pipeline.ts`):

| Step | Kind | What it does |
| --- | --- | --- |
| Revenue at risk | code (`src/scoring/revenue.ts`) | Formula above, weighted by 1 / `sample_rate`, scaled past the cluster's session-list cap. A session counts once it has been idle `ABANDON_AFTER_IDLE_MS` (ordered or not, so early rates are not biased toward zero). Baseline: unaffected sessions with a cart that visited the issue's route, widened to all routes below `BASELINE_MIN_SESSIONS`. Never negative; `insufficient_data` until `RAR_MIN_AFFECTED` affected sessions have finished. |
| Base tier | code (`src/scoring/priority.ts`) | The most urgent matching rule in the priority rule set (below). |
| Evidence pack | code (`src/evidence.ts`) | E1 issue facts, E2.. up to five signals (detector facts, selector, release, primitive detector values), up to three error signatures, releases, impact numbers; for root cause, the screenshot. No session or signal ids, no node ids, no events, no HTML. |
| Triage | ADK `LlmAgent`, `GEMINI_MODEL_BULK` | Title, category, confidence, summary, likely cause, repro steps. |
| Screenshot | Playwright + rrweb replayer (`src/visual/screenshot.ts`) | Renders the stored, masked replay 600 ms after the flag, flagged element outlined in red, in a sandboxed iframe with the network off. Stored at `screenshots/{tenant}/{cluster}/{signal}.png` (same lifecycle rule as `raw/`). |
| Root cause | ADK `LlmAgent`, `GEMINI_MODEL_REASONING`, image attached | Hypothesis, visual check (`confirmed`, `not_confirmed`, `unclear`, `not_checked`), notes, where to look first. `not_confirmed` marks the finding `suspect` (shown as "Needs review"); it is not dropped. |
| Ranker | ADK `LlmAgent`, `GEMINI_MODEL_BULK` | Cites the priority rules that apply and may propose a one-tier move with a cited rule. |
| Final tier and score | code | The move is applied only if the cited rule is known, cited, and its own tier supports the target. Score = revenue at risk (major units) x tier weight (P0 1, P1 0.75, P2 0.5, P3 0.25) x 1.5 for a release regression. The feed sorts by tier, then score. |

How the agents run (`src/llm/run-agent.ts`): one `LlmAgent` per call with an `outputSchema` (zod, converted by ADK to Gemini structured output), `includeContents: 'none'`, no transfers, temperature 0, and the instruction passed as a function (ADK would otherwise read braces as state placeholders). The evidence is gathered by deterministic code before the call rather than through tool calls, which keeps the inputs auditable and the prompt hash meaningful. Every output passes the zod parse and the grounding validator (`src/grounding.ts`: unknown evidence ids, unknown priority rules, a visual verdict that does not cite the screenshot, a move without a cited rule); a rejected output is retried once with the validator's message, then the step fails closed and the finding keeps its deterministic title, tier and score. Rate limits and transient errors back off exponentially without spending the retry.

Caching: the agents re-run only when the issue's `llm_key` changes: symptoms, error signatures, releases, fingerprints, the session count's power of two (1, 2, 4, 8, ...), the rule set, the models, or `PROMPT_VERSION`. Otherwise the previous analysis and the exact evidence pack it cites are kept, and only the scores are recomputed.

Priority rule set (v1, `DEFAULT_PRIORITY_RULES`, override with `PRIORITY_RULES`): `checkout_blocker` P0 (element on /checkout or /payment with errors), `pricing_error` P1 (any data rule), `checkout_friction` P2 (element on /cart, /bag, /checkout, /payment), `browse_friction` P3 (everything else), `release_regression` (x1.5 when the issue's releases first appeared shortly before it and an older release exists). The service records the rules in the `rules` table (kind `builtin`, `definition.type = priority`) at startup; every finding carries the rule set's content hash.

Without `GOOGLE_API_KEY` (`AGENT_LLM=auto`) both model tiers are an offline stand-in (`src/llm/offline.ts`): an ADK `BaseLlm` that composes grounded, templated answers from the evidence and never claims a visual check. Findings record its model id (`offline-stand-in`), and the dashboard says the text is templated. `AGENT_LLM=vertex` uses Gemini on Vertex AI with application default credentials.

Storage: a finding is one per issue (`finding_id` = `cluster_id`). A new version row goes to the `findings` table only when the version hash changes (analysis, tier, score, status, priority decision, revenue, affected sessions); `valid_from` is the issue's first signal, `recorded_from` the pass time, and `recorded_to` comes from the `findings_versions` view. Phase 3 added nullable columns: `cluster_id`, `title`, `status`, `score`, `input_hash`, `details` (JSON: agent outputs, priority decision, revenue inputs, run log, evidence pack). The latest version also goes to Firestore `findings/{tenant}__{finding_id}` (gzipped payload, index tenant_id + score desc) for the feed.

Triggering: a timer every `AGENT_POLL_MS` (default 5 s), or `POST /run`. On Cloud Run the agent is private, has one instance with CPU always allocated, and skips screenshots by default because the slim image has no browser (`pnpm deploy:agent`; set `AGENT_DEPLOY_VISUAL_CHECK=true` with an image that has Chromium). `src/agent.ts` exports `rootAgent` (the triage agent) for ADK's own tools.

Tests use hand-written fixtures in Gemini's response shape (`apps/agent/test/fixtures`) and the offline stand-in; nothing calls Gemini. They have not been recorded from live Gemini yet, because no key was available when this was built. The screenshot test needs a browser: `CP_BROWSER_TESTS=chrome pnpm --filter @cp/agent test`.

## 6. Bitemporal search and retroactive re-scan

Retroactive re-scan is the feature to demo: change or add a rule, re-run it over the past 30 days, and see which users were already hurt, without overwriting what the system believed at the time.

Three kinds of question, each answered by filtering one or both clocks from section 3:

| Question | Filters on | Example |
| --- | --- | --- |
| When did users hit this? | Valid time | Sessions with the coupon bug between 1 and 14 Sep |
| What did we know then? | Transaction time | What the dashboard showed on 15 Sep |
| What did we know then about then? | Both | On 15 Sep, what did we think happened 1 to 14 Sep, versus what we know now |

The third row is the one I did not find any competitor marketing: the gap between the two answers is the bugs the old rules missed.

```sql
-- Findings as we believed them on 15 Sep about events during 1-14 Sep
SELECT finding_id, severity, revenue_at_risk_minor
FROM findings
WHERE valid_from < TIMESTAMP('2026-09-14')
  AND (valid_to IS NULL OR valid_to > TIMESTAMP('2026-09-01'))
  AND recorded_from <= TIMESTAMP('2026-09-15')
  AND (recorded_to IS NULL OR recorded_to > TIMESTAMP('2026-09-15'));
```

Re-scan flow:

1. A rule is created or edited, producing a new row and version in `rules`. A dry run over the last 1,000 sessions shows hit rate and sample hits.
2. A human approves; a Cloud Run Job scans the chosen window, 30 days by default.
3. New signals are written with the new `rule_version`, their original `event_time`, and `ingest_time` = now.
4. The clusterer writes new finding versions and closes the old ones.
5. The dashboard tags each finding as known at the time or found later, with sessions affected since the bug began.

Two execution paths:

- Fast path: rules over signals, probe values, or the normalized event stream. The processor also writes a compact Parquet copy of the normalized stream to Cloud Storage as a derived cache, rebuildable from raw, exposed to BigQuery as an external table. Re-runs take minutes.
- Rebuild path: a rule needing a selector nobody probed. A Cloud Run Job replays raw chunks in headless Chromium using the rrweb replayer and evaluates the new selector. It is slower and costs more, so cap it per run and treat it as phase 2 unless time allows.

Cost guard: partition pruning by event date and a maximum-bytes-billed setting on every re-scan query.

## 7. Dashboard and API

The dashboard is a ranked findings feed with one click from any finding to the exact replay moment, plus a time-travel control that makes the bitemporal model visible.

Views:

- Overview: revenue at risk over the last 7 days, open findings by tier, sessions ingested, and measured detection latency.
- Findings feed: ranked cards showing title, tier, revenue at risk, affected sessions, first and last seen, release, and a known-at-the-time or found-later tag.
- Finding detail: Gemini summary and repro steps, the visual-verification screenshot, related errors, and evidence items that open the rrweb player at the signal time.
- Rules: detector parameters, the probe registry, and plain-English rule authoring with a dry-run result before activation.
- Time travel: an as-of date and a valid-time range that re-query the feed, so a viewer can watch the retroactive re-scan change the picture.

API surface (REST on Cloud Run):

| Endpoint | Purpose |
| --- | --- |
| POST /v1/ingest | Collector; site-key auth, gzip batches |
| GET /v1/findings | List with filters: status, tier, route, release, as_of, valid_from, valid_to |
| GET /v1/findings/{id} | One finding with its version history |
| GET /v1/findings/{id}/evidence | Signals and short-lived signed replay URLs |
| POST /v1/rules | Create a rule version, including plain-English drafts |
| POST /v1/rules/{id}/dry-run | Hit rate and samples over recent sessions |
| POST /v1/rules/{id}/rescan | Start a retroactive re-scan job for a window |

Read path. BigQuery is the source of truth, but it is a poor fit for low-latency UI reads. The agent service also writes the latest version of each finding to Firestore, and the feed subscribes to it for live updates. Time-travel queries go to BigQuery.

Suggested front end: React and Vite on Firebase Hosting, calling the Cloud Run API.

### Implemented so far (25 Sep): signals list and session replay

**Read API (`apps/api`).** Local only for now: it binds to loopback and has no authentication. Phase 3 adds auth and short-lived signed replay URLs before it is deployed.

| Endpoint | Returns |
| --- | --- |
| `GET /v1/signals?tenant=&session=&limit=` | Newest first, deduplicated |
| `GET /v1/sessions/{id}/replay?tenant=` | `{session, events, markers}` |

How the replay payload is built:

- `events` are the session's stored, scrubbed chunks, stitched in seq order.
- Each marker places a signal on the replay's own clock: `replay_ts = evidence.tStart − (collector_received_at − client_sent_at)` of the chunk the event came from. Markers carry `node_id` and `selector`.
- Every BigQuery read filters on `tenant_id` and the partition column and sets `maximumBytesBilled`.
- Replay responses are `no-store`.

**Replay viewer (`apps/dashboard`, React + Vite + rrweb-player).**

| Feature | Behavior |
| --- | --- |
| Pointer | The shopper's pointer is drawn as a blue ring with a fading trail (`mouseTail`); clicks flash rose. |
| Flag markers | Each signal is injected into the event stream as a `cp.flag.<detector>` Custom event. The player's `tags` option draws it as a colored mark on the timeline. |
| Timeline | Network and navigation metadata are dropped from the player's stream; JS errors stay as pink marks. |
| Short clip | Opening a signal plays a short clip (6 s before to 3 s after, via `playRange`). |
| Pinpointing | When playback reaches a flag, the element is found through the replay mirror (`node_id`, falling back to the selector). It is outlined in red, with a caption such as "Dead click on button#apply-coupon: no response within 800 ms". |

**Issues feed (implemented 6 Oct).** The dashboard opens on Issues, one card per cluster, most recently active first. It shows:

- the title, kind (element or data rule), and symptom chips with counts;
- the errors seen just before the symptom;
- affected sessions and last seen.

It refreshes every 3 s, and a card flashes when it gains signals. An issue page lists symptoms, errors, releases, the newest occurrences (each opening the replay at its flag), and every affected session.

| Endpoint | Returns |
| --- | --- |
| `GET /v1/clusters?tenant=&limit=` | Issues, newest activity first, without session lists |
| `GET /v1/clusters/{id}?tenant=&sessions=` | One issue with up to `sessions` (default 200, max 5,000) session ids, newest first |

**Findings (implemented 8 Oct, Phase 3).**

| Endpoint | Returns |
| --- | --- |
| `GET /v1/findings?tenant=&limit=` | Latest finding per issue, most urgent tier first, then score, without evidence packs or run logs |
| `GET /v1/findings/{id}?tenant=` | One finding with its evidence pack and agent runs, plus every stored version (`recorded_from`, derived `recorded_to`) |
| `GET /v1/findings/{id}/screenshot?tenant=` | The PNG the visual check used. It is served only from that finding's own `screenshots/{tenant}/{id}/` prefix, with `no-store`. |

The Issues feed is now ranked by finding: a tier badge, the agent's title, revenue at risk, and a "Needs review" flag for suspect findings. A total revenue-at-risk tile is labelled synthetic, and issues not yet scored come last.

The issue page opens with the finding. It shows:

- revenue at risk with the formula filled in;
- the base tier, the rules behind it, and the ranker's reason;
- the summary, repro steps, likely cause, and root-cause hypothesis;
- the visual check with its screenshot;
- the evidence list;
- a reproducibility table (model, prompt hash, attempts, rule set) and the version history.

Each claim carries evidence chips, and signal and screenshot chips open the replay at that moment. Offline stand-in output is labelled as templated.

`pnpm sim:check` also runs the Phase 3 exit test. Each bug's issue must have a finding with an agent summary and at least two repro steps, and a signal evidence item whose replay contains that flag.

Replay captions now cover every detector, for example "Rage clicks on button#place-order: 5 clicks in 2.2 s, 5 failed" or "Cart total doesn't match its line items: shows ₹9,715.50, expected ₹29,146.50" (from a synthetic sim session). Invariant markers outline the probe element (`[data-cp-probe="cart_total"]`).

**Route per click.** A batch can span a navigation, so the normalizer tracks the current route (Meta loads and `cp.nav`) and stamps it on each click. dead_click (v1.2.0) fingerprints on the click's own route, not the route of the batch that decided it. The e2e check caught this: before the fix, the last clicks before navigating away got a different fingerprint.

## 8. Privacy and security

Treat privacy as an architecture constraint: nothing sensitive should leave the browser, and nothing sensitive should reach Gemini. rrweb's defaults are permissive, so masking has to be configured deliberately.

According to the rrweb guide, `maskAllInputs` defaults to false and only password inputs are masked by default. A GitHub issue against rrweb 2.0.0-alpha.18 also reports hidden inputs escaping `maskAllInputs`, open when checked. Verify against the version you pin, and do not rely on client masking alone.

| Layer | Control | Enforced in |
| --- | --- | --- |
| Capture | `maskAllInputs: true`; `blockSelector` for payment and identity elements; `maskTextSelector` for account, address, and order-confirmation text; `maskInputFn` and `maskTextFn` for pattern masking of emails, phone numbers, and card-like digit runs. As built (`apps/sdk`): every text node passes through the pattern mask, `[data-cp-mask]` text is fully masked, `[data-cp-block]` and `cc-*` fields are blocked, and page-load URLs lose their query and fragment before batching. The one-tag bundle is about 26 KB gzipped, including rrweb record. | Browser SDK |
| Probes | Allowlisted selectors only, values parsed to numbers and currency before leaving the browser; probe text is never sent as text | Browser SDK |
| URLs | Drop query strings and fragments from `url_path` by default | Browser SDK |
| Ingest scrub | Second-pass scrubber over the batch JSON before it is written to Cloud Storage; reject unknown site keys; fail closed on parse errors. As built: every input `value` is masked; text and text-bearing attributes (`aria-label`, `title`, `alt`, ...) are pattern-scrubbed; URLs lose query and fragment. SVG and geometry attributes (`d`, `viewBox`, coordinates, transforms) are exempt from pattern scrubbing: they look like phone numbers to the regex, cannot hold typed input, and scrubbing them broke every icon in replays. | Collector |
| LLM boundary | Gemini receives structured evidence and screenshots rendered from the already-masked replay, never raw HTML | Agent service |
| Tenancy | `tenant_id` on every row; per-tenant Cloud Storage prefix; BigQuery row-level policies or per-tenant authorized views; replay URLs are short-lived signed URLs | Data and API |
| Retention | Lifecycle rule on raw chunks (30 days as a starting default, configurable per tenant); signals and findings carry no page content and can live longer; delete by session_id through the raw_chunks index | Storage |

Region. Keep the Cloud Storage bucket, BigQuery dataset, and Cloud Run services in one region near the tenants, for example asia-south1 or asia-southeast1, so data residency is a config choice rather than a rewrite.

Consent. The SDK should start only after the host site's consent banner allows it. Rules differ by country across JAPAC, so get legal review before any real customer data flows; for the hackathon, run on synthetic sessions from the demo shop only.

## 9. Scaling and cost controls

The architecture scales because volume shrinks at every tier: many sessions become fewer signals, signals become clusters, and only clusters reach the LLM. The order in which things break, and the fix for each:

| Stage | What breaks first | Mitigation |
| --- | --- | --- |
| Browser SDK | Payload size and main-thread cost on heavy pages | Use rrweb `sampling` to throttle mouse-move and scroll, `packFn` compression, periodic checkouts, and a hard cap on batch bytes |
| Collector | Bursts at campaign or sale time | Cloud Run autoscaling with a minimum instance count; body size limit; idempotency on session_id and seq |
| Pub/Sub | Large messages and head-of-line blocking on a hot session | Messages carry the Cloud Storage URI and metadata only, never the events; ordering key is session_id |
| Processor state | Firestore read and write per chunk becomes the bottleneck and the bill | Cache the session tail in memory with a TTL, write only on change, move to Memorystore if needed |
| BigQuery | Many small inserts and full-table scans | Batch through the Storage Write API; partition by event date; cluster by tenant_id and session_id; never query raw chunks from BigQuery |
| Clusterer | Fingerprint cardinality explosion | Selector normalization, a per-tenant cluster cap, and only the top 5 evidence items stored per cluster |
| Agent and LLM | Cost and rate limits | Run per cluster, skip re-triage when a cluster is unchanged for the same release, add backoff, and process top-N first |
| Dashboard | BigQuery latency on live views | Firestore hot copy of the latest finding versions |

Edge sampling with a ring buffer. The SDK keeps the last 30 seconds of events in memory and ships a session only when a local trigger fires (rage or dead click, JS error, failing probe), plus an unbiased baseline sample of ordinary sessions. Do not skip the baseline: revenue at risk in section 5 needs unaffected sessions to compare against, and trigger-only sampling would bias abandonment upward. Record the sampling rate on each session so counts can be re-weighted.

Why the funnel matters for cost. Gemini 3.8 Flash is listed at $0.75 per million input tokens and $3.75 per million output tokens through 31 Dec 2026, rising to $1.50 and $7.50 on 1 Jan 2027. With illustrative assumptions of 6,000 input and 1,000 output tokens per call, triaging 200 clusters a day costs about $1.65. Sending each of 1,000,000 daily sessions through the same call would cost about $4,500 in input tokens alone. Treat both as lower bounds, since the model can spend more tokens on hard tasks.

Beyond one tenant. Give large tenants their own Pub/Sub subscription and Cloud Run concurrency limits, enforce a per-site-key quota, and keep every table keyed by tenant_id so a noisy customer cannot starve the rest. Cloud Logging is the wrong sink for this data: a log entry is capped at 256 KiB and the limit cannot be raised; use it only for our own service logs.

## 10. GCP service map and repository layout

Everything runs on Cloud Run plus managed data services, which satisfies the Cup requirement to use Gemini or Google's agent platforms and to deploy on Cloud Run or Firebase.

| Need | GCP service | Notes |
| --- | --- | --- |
| Collector, processor, clusterer, agent, API | Cloud Run | One service each; the agent deploys with `pnpm deploy:agent` (same image as the others) |
| Event fan-out | Pub/Sub | Topics: events.raw (ordering key = session_id) and signals; subscriptions events.raw.processor and signals.clusterer, each with a dead-letter topic |
| Raw chunks and Parquet cache | Cloud Storage | Per-tenant prefix, lifecycle rule for retention |
| Signals, findings, rules, business events | BigQuery | Partitioned by event date, clustered by tenant_id and session_id |
| Hot session tail, live issues, latest findings | Firestore | Session tail and markers with a TTL; `clusters` behind the live issues feed (composite index tenant_id, last_seen desc); `findings` (composite index tenant_id, score desc) |
| Re-scan and rebuild work | Cloud Run Jobs | Started by the API; capped per run |
| Dashboard hosting | Firebase Hosting | React and Vite build |
| API keys and site keys | Secret Manager | Gemini key held here per the ADK Cloud Run docs |
| Our own service logs and alerts | Cloud Logging and Monitoring | Never customer session data |

Gemini can be reached with an AI Studio API key for speed during the hackathon, or through Google's agent platform with service-account auth for a production posture. Both are named as acceptable in the Cup rules; quotas have not been compared.

Monorepo layout: see `AGENTS.md`. The `sim` folder matters as much as any service: it produces the hundreds of realistic sessions that make the dashboard and the retroactive re-scan demonstrable.

Simulator (implemented 6 Oct). `pnpm sim -- --sessions 300 --seed 42 --concurrency 8` drives the demo shop in real Chrome, so the real SDK, probes, collector, processor, and clusterer all run.

- **Plans.** Seeded plans (`sim/src/plan.ts`) give the mix: 20% dead_button, 15% cart_total, 15% checkout_error, and 50% clean.
- **Near misses.** Half of the clean sessions carry a bug flag whose trigger they never reach: at most 2 coupon presses, a discounted first line kept at quantity 1, or a region other than Northeast. A test asserts that affected plans reach their trigger and clean plans never do.
- **Abandonment.** Affected shoppers abandon more often than the baseline by design (60%, 40%, and 85% against 25%). Every session is recorded (sample rate 1), so the baseline is unbiased.
- **Ground truth.** It goes to `sim/out/ground-truth.json`.
- **Scoring.** `pnpm sim:check` waits for the pipeline to go quiet, then scores the issues against the ground truth: one issue per bug, precision 100%, recall ≥ 90%, no clean session in any issue, no stray issues. It writes `sim/out/check-report.json`.

### Runtime modes, configuration, and logs (implemented 25 Sep)

One switch, `CP_MODE`, selects the adapters behind the ports in `packages/platform`. Every setting is in `.env.example`.

| Port | `local` (default, no credentials) | `gcp` |
| --- | --- | --- |
| Blob store | `.data/gcs/` | Cloud Storage, write-if-absent |
| Publisher | `.data/pubsub/*.jsonl` plus HTTP push in Pub/Sub push format (events.raw to the processor on :8081, signals to the clusterer on :8083), retried, ordered per key | Pub/Sub with message ordering |
| Warehouse | `.data/bq/<table>.jsonl`, deduplicated on insertId | BigQuery streaming insert |
| Session state and issues | `.data/firestore/` (issue updates serialized per issue in process) | Firestore (tail and issues stored as gzipped bytes; TTL on `expires_at`; issue updates in transactions) |

How the processor and clusterer receive messages:

| Where it runs | Intake |
| --- | --- |
| Local mode | HTTP push from the local publisher |
| Cloud Run | Authenticated Pub/Sub push to `/pubsub/push`, set up by `pnpm deploy:processor` and `pnpm deploy:clusterer` |
| A laptop against real GCP, before deploy | Streaming pull (`PROCESSOR_PULL=true`, `CLUSTERER_PULL=true`) |

A poison message is acked and logged; it is not retried. Transient failures return 500 so Pub/Sub retries, and after 10 attempts the message goes to `events.raw.dlq` or `signals.dlq`.

Logs are our own service logs only (rule 8). pino writes them in one of three formats:

| Setting | Output |
| --- | --- |
| Pretty (default locally) | One colored line per event, tagged `[collector]` or `[processor]`. `pnpm dev` merges both services into one terminal. |
| gcp (auto on Cloud Run) | Structured JSON on stdout (`severity`, `message`, `serviceContext`, trace ids), which Cloud Logging and Error Reporting parse with no agent. |
| `LOG_TO_CLOUD=true` | A local run also ships batched entries to Cloud Logging under the log name `cp-local`. |

`pnpm logs:tail` streams both kinds of entry back into the terminal. A redaction list censors payload keys (`events`, `body`, `envelope`, `site_key`, `evidence.values`, and auth headers) as a backstop. The code logs ids, counts, timings, detectors, fingerprints, and selectors only.

`pnpm infra:up` creates the resources in the service map above in one region, idempotently. Data resources are created through the client libraries; APIs, service accounts, IAM, Firestore, Artifact Registry, and secrets through gcloud. `pnpm deploy:<service>` does the rest:

1. Gates on `pnpm build` and `pnpm test`.
2. Builds the root `Dockerfile` with Cloud Build.
3. Deploys to Cloud Run with a per-service service account:
   - the collector is public, since site-key auth protects it;
   - the processor and clusterer are private, invoked only by the Pub/Sub push identity.

## 11. Build plan to submission

The Cup's home page lists the building phase as 7 Sep to 18 Oct 2026, with submission due 18 Oct, so we have 25 days from 23 Sep; build a thin vertical slice first and add depth in layers. Its FAQ says registration closes 4 Oct while the home page says team formation runs to 11 Oct, so register by 4 Oct to be safe. The home page also lists eligibility as ages 21 and over, working professionals, entrepreneurs, and startups, with students ineligible: confirm this applies to the whole team.

| Dates | Phase | Deliverable | Exit test |
| --- | --- | --- | --- |
| 23 to 25 Sep | 0. Foundations | Team registered, GCP project, monorepo, shared schema package, infra scripts for topics, bucket, and datasets, demo shop skeleton with bug flags | `infra` creates everything from scratch in one command |
| 26 Sep to 1 Oct | 1. Vertical slice | SDK to collector to Pub/Sub to processor with one detector (dead_click) to BigQuery to a bare findings list | Clicking the broken button in the demo shop produces a signal row within a minute |
| 2 to 7 Oct | 2. Detector set | rage_click, response_decay, error_correlation, probes and invariant_check; clusterer with fingerprints; Firestore live feed; `sim` generating a few hundred sessions | The three injected bugs each collapse into one cluster |
| 8 to 12 Oct | 3. Agent layer | Triage, visual verification, revenue-at-risk score, priority rule set; finding detail page with replay at the signal moment (built 8 Oct; see section 5) | A finding shows a Gemini summary, repro steps, and a working replay link |
| 13 to 15 Oct | 4. Bitemporal | Versioned findings, time-travel controls, plain-English rule author with dry run, fast-path retroactive re-scan | Adding a rule surfaces past sessions tagged found-later |
| 16 to 17 Oct | 5. Harden and package | Final deploy to Cloud Run and Firebase, 3-minute video, deck, README, public repo cleanup | A fresh browser runs the whole demo with no console errors |
| 18 Oct | Submit | Prototype link, video, public repo, deck | Submitted a day early if possible |

Demo shop bug flags:

- `BUG_DEAD_BUTTON`: the Apply Coupon button silently stops responding after the fifth click.
- `BUG_CART_TOTAL`: the cart total ignores quantity on one line when a discount is applied, so it differs from the sum of line items.
- `BUG_CHECKOUT_ERROR`: the payment step throws a JS error and a 500 for one region, producing rage clicks and abandonment.

The `sim` generator runs several hundred scripted sessions with randomized behavior, where bug-affected sessions abandon at a higher rate than the rest. Those rates are parameters we choose, so say clearly in the demo and README that the data is synthetic.

Splitting the work (fold tracks together if the team is two people):

- Track A, capture and ingest: SDK, probes, ring buffer, collector, infra.
- Track B, detection: normalizer, detectors, processor, clusterer.
- Track C, intelligence: ADK agents, scoring, rule author, bitemporal queries and re-scan.
- Track D, product and demo: dashboard, demo shop, `sim`, video and deck.

## 12. Demo script and risks

The 3-minute video should spend about a third of its time on the retroactive re-scan, because that is where innovation and technical merit meet. The Cup scores technical merit and Gen AI implementation at 40%, problem alignment and impact at 25%, innovation and creativity at 25%, and user experience at 10%.

| Time | Show | Say | Scores on |
| --- | --- | --- | --- |
| 0:00 to 0:20 | Demo shop cart where the total does not match its lines | Users do not report this; they leave | Problem alignment |
| 0:20 to 0:50 | Click Apply Coupon six times; a quick architecture frame | One script tag streams rrweb sessions through Pub/Sub into our detectors | Technical merit |
| 0:50 to 1:30 | Findings feed: three findings from hundreds of sessions; open one | Clustered, ranked by revenue at risk; Gemini explains it and confirms it visually; jump to the replay moment | Gen AI implementation |
| 1:30 to 2:10 | Type a plain-English rule; dry run; approve; re-scan | A new rule finds last week's sessions nobody knew were broken | Innovation |
| 2:10 to 2:40 | Move the as-of control | What we believed then versus what we know now | Innovation and UX |
| 2:40 to 2:55 | Funnel counts: sessions, signals, clusters, Gemini calls | The LLM only sees clusters, so cost stays flat as traffic grows | Technical merit and impact |

Record from pre-warmed services and keep a pre-recorded fallback clip.

Top risks:

| Risk | Mitigation or fallback |
| --- | --- |
| Judges say existing session-replay tools already do this | Concede that rage-click detection is common; lead with business-rule invariants and retroactive re-scan, and name the gap plainly |
| The rebuild path (headless replay) consumes the schedule | Keep the demo on the fast path; treat rebuild as phase 2 |
| False positives from detectors | Visual verification, tunable parameters, dry run, and precision measured against sim ground truth |
| Revenue at risk looks made up on synthetic data | State it is synthetic, show the formula, and use the affected-versus-baseline difference |
| Live demo failure from cold starts, quota, or model latency | Minimum instances, cache Gemini output per fingerprint and release, fallback recording |
| Gemini model IDs change or move to preview | Read model IDs from config and pin to GA models |
| Eligibility or registration dates differ from what we assumed | Confirm on the official pages this week and register by 4 Oct |

## Sources

Pages opened while preparing this plan, as of 23 Sep 2026.

- [AI Builder Cup 2026: home, timeline and eligibility](https://aibuildercup.com/)
- [AI Builder Cup 2026: FAQs](https://aibuildercup.com/Faqs.html)
- [AI Builder Cup 2026: themes and judging criteria](https://aibuildercup.com/themes.html)
- [Gemini API: latest model](https://ai.google.dev/gemini-api/docs/latest-model)
- [Gemini API: release notes](https://ai.google.dev/gemini-api/docs/changelog)
- [Agent Development Kit overview](https://adk.dev/)
- [ADK: deploy to Cloud Run](https://adk.dev/deploy/cloud-run/)
- [rrweb guide (record options)](https://github.com/rrweb-io/rrweb/blob/main/guide.md)
- [rrweb issue 1609: hidden inputs not masked](https://github.com/rrweb-io/rrweb/issues/1609)
- [rrweb: best open source session replay tools](https://rrweb.com/blog/best-open-source-session-replay-tools)
- [Cloud Logging quotas and limits](https://docs.cloud.google.com/logging/quotas)
