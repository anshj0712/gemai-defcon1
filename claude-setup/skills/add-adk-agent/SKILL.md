---
name: add-adk-agent
description: Add or modify an ADK (TypeScript) agent in apps/agent, such as triage, root-cause, rule-author, or ranker. Covers prompts, tools, JSON output schemas, the grounding validator, model config, and deploying to Cloud Run.
---

# Add or modify an ADK agent

ADK is the Agent Development Kit. The TypeScript release (2.0) supports graph workflows that mix deterministic steps and LLM steps, which is the shape we want: deterministic code around, Gemini inside.

Check the installed `@google/adk` version's types and docs before writing against its API. Do not code from memory.

## Steps

1. Decide the agent's single job and its output schema. Define the schema once with zod in `packages/schema` and convert it to JSON schema for structured output.
2. Put the agent under `apps/agent/src/agents/<name>/`. Deterministic pieces (scoring, validation, evidence lookup) live outside the prompt as plain functions and are wired as tools or workflow nodes.
3. Tools return evidence objects that each carry an id. Tools are read-only and tenant-scoped.
4. Prompt: state the job, the schema, and the rule that every claim must cite evidence ids from the input. Provide no raw rrweb events or HTML, only structured evidence and masked screenshots.
5. Run the grounding validator on every output: reject any cited id that was not supplied, and reject missing required fields. On rejection, retry once with the validator's message, then fail closed.
6. Read model IDs from `GEMINI_MODEL_BULK` (triage) and `GEMINI_MODEL_REASONING` (root cause, rule author). Never hard-code them.
7. Store on the finding: prompt hash, model id, and rule version.
8. Skip the call when the cluster is unchanged for the same release (cache by fingerprint and release). Process top clusters first. Back off on rate limits.
9. Tests use recorded fixtures only. No live model calls in unit tests. Add a test that the validator rejects an output citing an unknown id.
10. Update the agent table in `AGENTS.md` and section 5 of `docs/ARCHITECTURE.md` if inputs or outputs changed.

## Ranker rules

- Score is computed in code from revenue at risk, confidence, and the priority rule set. The LLM classifies into priority buckets and cites rule ids.
- The LLM may move a finding by at most one severity tier, and only with a cited rule id.

## Deploying an agent to Cloud Run (verified against the ADK docs on 23 Sep 2026)

- The deploy root needs `package.json` with `@google/adk` and an `agent.ts` that exports `rootAgent`.
- Set `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`. In PowerShell, use `$env:GOOGLE_CLOUD_PROJECT = "..."`.
- Store the Gemini key in Secret Manager as `GOOGLE_API_KEY` and grant the service account `roles/secretmanager.secretAccessor`.
- Deploy with `npx adk deploy cloud_run --project=$GOOGLE_CLOUD_PROJECT --region=$GOOGLE_CLOUD_LOCATION --service_name=<name>`. Add `--with_ui` only for development.
- For the full deploy checklist across services, use the `deploy-gcp` skill.
