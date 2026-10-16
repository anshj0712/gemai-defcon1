# Churn Preventer Agent

A checkout-focused pipeline that finds friction and silent data bugs in live rrweb sessions, ranks them by revenue at risk, and lets a merchant re-scan history with new rules. Built for the Google Cloud AI Builder Cup 2026 (Retail & Commerce theme).

- Submission is due 18 Oct 2026 per the Cup home page; register by 4 Oct to be safe (the FAQ and home page disagree). Confirm dates and eligibility on the official pages.
- Judging weights: technical merit and Gen AI 40%, problem alignment and impact 25%, innovation 25%, UX 10%.
- Full spec: `docs/ARCHITECTURE.md`. Read the section for the component you are changing before you write code.

## Non-negotiable rules

1. Deterministic code decides what is a finding and how it scores. Gemini explains, verifies visually, and drafts rules.
2. Gemini never sees raw rrweb events or raw HTML. Its inputs are structured evidence (signals, selectors, DOM diffs, probe values) and screenshots rendered from already-masked replays.
3. Raw chunks in Cloud Storage are immutable. Everything else is derived and must be rebuildable from raw.
4. Never update a signal or finding in place. A change writes a new version row, and the previous version is closed (`recorded_to`). Every row carries valid time (`event_time`) and transaction time (`ingest_time` or `recorded_from`). Exact pattern: skill `bitemporal-rescan`.
5. Every stage is idempotent, keyed by `(session_id, seq)`. Pub/Sub delivers at least once.
6. Privacy by default: mask inputs, block payment and identity elements, strip URL query strings, scrub again at the collector. The demo uses synthetic sessions only.
7. Model IDs and detector thresholds come from config or env, never hard-coded. As of 23 Sep 2026 both are GA: `gemini-3.5-flash-lite` (bulk triage) and `gemini-3.8-flash` (reasoning and vision). Re-check the Gemini API release notes before relying on them.
8. Do not write session data to Cloud Logging (256 KiB entry cap, and privacy). Cloud Logging is for our own service logs only.
9. Revenue at risk = affected sessions with a cart x average cart value x (abandonment of affected sessions minus abandonment of baseline sessions). Never count baseline abandonment as lost revenue. Keep an unbiased baseline sample and record the sampling rate on each session.
10. Wherever demo numbers appear, say they are synthetic.

## Architecture in one screen

Browser SDK (rrweb, masking, probes, 30 s ring buffer) -> Collector (Cloud Run) -> raw chunks in Cloud Storage and a small envelope on Pub/Sub `events.raw` -> Processor (Cloud Run: normalizer and detectors, session tail in Firestore) -> signals in BigQuery and Pub/Sub `signals` -> Clusterer (fingerprints) -> Agent service (ADK and Gemini) -> findings in BigQuery and Firestore -> Dashboard and API (Cloud Run, Firebase Hosting).

## Repo layout

```text
apps/
  sdk/            browser SDK: rrweb wrapper, probes, ring buffer, local triggers
  collector/      Cloud Run: validate, scrub, write to GCS, publish to Pub/Sub
  processor/      Cloud Run: subscription shell, session tail state, run detectors, write signals
  clusterer/      Cloud Run: groups signals into issues (route + element, or rule id) in Firestore, idempotent per signal
  agent/          ADK agents: triage, root cause, rule author, rule suggester, ranker; scoring lives in src/scoring
  api/            Cloud Run REST API
  dashboard/      React + Vite on Firebase Hosting
  demo-shop/      e-commerce demo with switchable bug flags
packages/
  schema/         shared zod types: envelope, Signal, Finding, Rule, BigQuery table specs
  logger/         pino logger: pretty locally, Cloud Logging JSON on Cloud Run, optional shipping from local runs
  platform/       I/O ports with local and GCP adapters: blob store, publisher, warehouse, session state, config
  normalizer/     rrweb events to normalized stream
  detectors/      rage_click, dead_click, response_decay, invariant_check, error_correlation
  testkit/        synthetic rrweb sessions and fixtures for tests and `pnpm smoke` (dev only)
sim/              Playwright scripts: the replay e2e check, and the session simulator with ground truth and its scorer
infra/            scripts for topics, buckets, datasets, IAM (`pnpm infra:up`), Cloud Build config
scripts/          dev runner, smoke test, deploy, logs tail
docs/             ARCHITECTURE.md
```

## Stack and conventions (defaults chosen for the build; change them here if the team decides otherwise)

- TypeScript in strict mode everywhere, including the ADK agents (`@google/adk`). Node 22 or newer. pnpm workspaces. zod for schemas. Vitest for tests.
- Money is an integer in minor units (`value_minor`) plus a currency code. Timestamps are epoch milliseconds UTC in code and TIMESTAMP in BigQuery.
- Detectors are pure functions over the normalized stream: no I/O, no clocks, no randomness.
- Shared types live in `packages/schema`. Do not redefine the envelope, Signal, Finding, or Rule elsewhere.
- Development machines are Windows. Write scripts in Node or TypeScript rather than bash-only, and build paths with `node:path`.
- Keep commits small, one concern each. Every detector and every SQL change ships with tests.

## Commands (keep this list current)

Available: `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm test` (one package: `pnpm --filter @cp/detectors test`), `pnpm dev` (collector, processor, clusterer, agent, api, demo shop, dashboard; merged logs), `pnpm dev:backend`, `pnpm dev:shop`, `pnpm dev:dashboard`, `pnpm smoke` (Phase 1 exit test on a synthetic session), `pnpm e2e` (real Chrome drives the demo shop and checks the replay and its issue), `pnpm sim -- --sessions 300 --seed 42 --concurrency 8` (synthetic shoppers with ground truth), `pnpm sim:check` (Phase 2 and 3 exit tests), `pnpm sim:rescan` (Phase 4 exit test: a merchant rule surfaces past sessions tagged found later), `pnpm sim:suggest` (agent-suggested rules exit test: the agent drafts a rule for the ghost_line issue, then approval surfaces its past sessions tagged found later), `pnpm rescan -- --tenant demo --rule <rule_id>` (re-scan history with an approved rule; the Cloud Run Job command), `pnpm build:sdk` (one-tag bundle), `pnpm infra:up` (`-- --dry-run` to preview), `pnpm deploy:collector`, `pnpm deploy:processor`, `pnpm deploy:clusterer`, `pnpm deploy:agent`, `pnpm dev:agent`, `pnpm logs:tail`, `pnpm clean`.

Runtime mode is one switch: `CP_MODE=local` (default; `.data/` stands in for GCP, no credentials) or `CP_MODE=gcp`. Every setting is documented in `.env.example`.

## Runtime agents (ADK, TypeScript)

| Agent | Model config key | Input | Output |
| --- | --- | --- | --- |
| triage | `GEMINI_MODEL_BULK` | Evidence pack: issue facts, up to 5 signals, error signatures, releases, impact numbers | JSON: title, category, confidence, summary, likely cause, repro steps (built) |
| root-cause | `GEMINI_MODEL_REASONING` | Triage output plus the evidence pack and a screenshot of the masked replay at the flag (gathered by code before the call, not via tool calls) | JSON: hypothesis, visual check, notes, where to look first (built) |
| rule-author | `GEMINI_MODEL_REASONING` | A merchant sentence in plain English, plus statistics of the recorded probes (no session data) | Rule JSON (a flat linear form code compiles into probes and an invariant), a dry run, then human approval and a retroactive re-scan (built) |
| rule-suggester | `GEMINI_MODEL_BULK` | Same evidence pack as triage and the ranker, plus probe statistics over the issue's own sessions, for a recurring issue a deterministic trigger picks (`RULE_SUGGEST_*`) that no active rule explains | `{propose, sentence, assumptions, explanation}`; the sentence is handed to rule-author, not compiled directly; the draft is marked `origin: agent` and still needs human approval (built) |
| ranker | deterministic core, bounded LLM step | Enriched finding and the priority rule set | Score, tier, and the priority rule ids applied (the LLM may move a finding at most one tier, and only with a cited rule id) (built) |

Every LLM claim must cite evidence ids we supplied; a validator rejects unknown ids. Each finding stores prompt hash, model id, and rule version. Without `GOOGLE_API_KEY` the agents run an offline stand-in (templated, labelled as such); see section 5 of the architecture doc.

## Definition of done

- `pnpm test` passes and new logic has tests.
- No rule above is violated. For SDK, collector, storage, logging, or LLM-input changes, run the `privacy-check` skill.
- `docs/ARCHITECTURE.md` is updated when an interface, table, or behavior changes.
- The demo path still works end to end: seeded sessions produce the expected findings (`pnpm sim:check`), and the retro and suggested-rule paths pass (`pnpm sim:rescan`, `pnpm sim:suggest`).
