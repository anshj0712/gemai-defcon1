---
name: deploy-gcp
description: Deploy or update the services on Google Cloud (Cloud Run services and jobs, Pub/Sub, Cloud Storage, BigQuery, Firestore, Firebase Hosting). Run manually with /deploy-gcp.
disable-model-invocation: true
---

# Deploy to Google Cloud

Run this only when the user asks. Confirm the project and region before changing anything, and ask before any delete or overwrite.

## Preflight

1. `gcloud auth list` and `gcloud config get-value project`: confirm the account and project with the user.
2. Pick one region for everything (suggested: `asia-south1` or `asia-southeast1`) and use it for every resource. Keep it in `infra/config`, not scattered through scripts.
3. Confirm secrets exist in Secret Manager (`GOOGLE_API_KEY`, site keys) and that no secret is in the repo.
4. Run `pnpm test` and `pnpm build`. Do not deploy a red build.

## Resources (idempotent; skip what exists)

- Pub/Sub topics: `events.raw` and `signals`, with the subscriptions the processor and clusterer use.
- Cloud Storage bucket for raw chunks and the Parquet cache, per-tenant prefixes, with a lifecycle rule for retention (30 days as a starting default).
- BigQuery dataset in the same region with tables: raw_chunks, signals, business_events, rules, findings, plus the findings_versions view. Partition by event date and cluster by tenant_id and session_id.
- Firestore in the same region for the session tail and the live findings feed.
- All of the above are created by `pnpm infra:up` (planned; create it in Phase 0).

## Services

Deploy each Cloud Run service from source, one at a time, and check its health before the next:

```text
gcloud run deploy <service> --source apps/<service> --region <region> --min-instances 1
```

- Order: collector, processor, clusterer, agent, api. The collector needs public ingress (site-key auth); the others should not.
- Agent service: use `npx adk deploy cloud_run` as described in the `add-adk-agent` skill.
- Re-scan and rebuild work runs as Cloud Run Jobs started by the API.
- Dashboard: build `apps/dashboard`, then `firebase deploy --only hosting`.
- Keep minimum instances at 1 for demo day so cold starts do not appear on camera; lower them afterward to save cost.

## After deploy

1. Run `pnpm sim -- --sessions 50` against the deployed collector and confirm signals and findings appear on the dashboard.
2. Check service logs for errors, and confirm no session content appears in them.
3. Note the deployed URLs in the README for the submission form.
