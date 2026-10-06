@AGENTS.md

# Claude Code workflow

The project brief, non-negotiable rules, layout, and conventions are in AGENTS.md above. This file covers how Claude should work in this repo.

## Working in this repo

1. Start each task by reading the section of `docs/ARCHITECTURE.md` that covers the component you are touching. Read sections, not the whole file.
2. For changes that span more than one app or touch `packages/schema`, plan first (plan mode), then implement.
3. Delegate by area to the project subagents below. Keep the main session for integration, cross-cutting decisions, and merging results.
4. Use the skills below for recurring procedures instead of re-deriving them.
5. Before calling a task done, run the tests for the touched packages and report the exact command and result. If a command listed in AGENTS.md does not exist yet, create it (Phase 0) rather than working around it.
6. Ask before adding a GCP service that is not in the service map, adding a runtime dependency to the SDK (bundle size matters), or changing the data model.
7. ADK, rrweb, and Gemini move fast. Check the installed package's docs or types before writing against an API; do not code from memory.

## Project subagents (`.claude/agents`)

| Subagent | Owns | Delegate when |
| --- | --- | --- |
| capture-engineer | `apps/sdk`, `apps/collector` | rrweb config, masking, probes, ring buffer, sampling, ingest endpoint |
| pipeline-engineer | `apps/processor`, `infra/`, BigQuery and Firestore setup, re-scan jobs | Pub/Sub handling, session state, table DDL, Cloud Run Jobs, bitemporal queries |
| detector-engineer | `packages/normalizer`, `packages/detectors`, `apps/clusterer` | New or tuned detectors, fingerprints, clustering |
| agent-engineer | `apps/agent` | ADK agents, prompts, JSON schemas, grounding validator, scoring |
| product-engineer | `apps/api`, `apps/dashboard`, `apps/demo-shop`, `sim/` | Dashboard views, API endpoints, demo shop bugs, session simulator |
| reviewer | read-only | Review a diff against the non-negotiable rules before merge |

A team of two can fold these together: one person takes capture, pipeline, and detection; the other takes agent and product.

## Skills (`.claude/skills`)

| Skill | Use for |
| --- | --- |
| add-detector | Adding or changing a detector, thresholds, or fingerprints |
| bitemporal-rescan | Anything involving valid time, transaction time, versioned findings, as-of queries, or retroactive re-scan |
| add-adk-agent | Adding or changing an ADK agent, its schema, tools, or validator |
| seed-demo-data | Running or extending the demo shop and the session simulator |
| privacy-check | Reviewing SDK, collector, storage, logging, or LLM-input changes |
| deploy-gcp | Deploying services to Cloud Run and Firebase (manual: run `/deploy-gcp`) |

## Build phases (from section 11 of the architecture doc)

| Dates | Phase | Exit test |
| --- | --- | --- |
| 23 to 25 Sep | 0. Foundations: team registered, GCP project, monorepo, schema package, infra scripts, demo shop skeleton | `infra` creates everything from scratch in one command |
| 26 Sep to 1 Oct | 1. Vertical slice: SDK to collector to Pub/Sub to processor with dead_click to BigQuery to a bare findings list | The broken button produces a signal row within a minute |
| 2 to 7 Oct | 2. Detector set, probes, invariants, clusterer, Firestore feed, sim | The three injected bugs each collapse into one cluster |
| 8 to 12 Oct | 3. Agent layer, scoring, finding detail with replay | A finding shows summary, repro steps, and a working replay link |
| 13 to 15 Oct | 4. Bitemporal, time-travel UI, rule author, fast-path re-scan | A new rule surfaces past sessions tagged found-later |
| 16 to 17 Oct | 5. Harden and package: final deploy, video, deck, README | A fresh browser runs the whole demo with no console errors |
| 18 Oct | Submit | Prototype link, video under 3 minutes, public repo, deck |

## Guardrails

- Never commit `.env` files, service-account keys, or API keys. Secrets live in Secret Manager.
- Do not run destructive `gcloud`, `bq`, or `gsutil` commands (delete, remove recursively, drop) without asking first.
- No live Gemini calls in unit tests. Use recorded fixtures, and cache LLM output per fingerprint and release.
- Do not put customer or session content in commit messages, issues, or logs.

## Open decisions (update this list as they are settled)

- Agent service language: assumed TypeScript with ADK 2.0. If the team prefers Python, change the conventions in AGENTS.md and the `add-adk-agent` skill.
- Gemini access: AI Studio API key from Secret Manager is the default for speed; Google's agent platform with service-account auth is the production posture.
- Team size decides how the tracks are split (see the subagent table).
- Cup registration date (4 Oct or 11 Oct) and team eligibility (ages 21 and over, working professionals, entrepreneurs, or startups; students ineligible) must be confirmed on the official pages.
