---
name: product-engineer
description: Owns everything a judge or merchant sees (apps/api, apps/dashboard, apps/demo-shop, sim/). Use for dashboard views, the REST API, the time-travel control, the demo shop and its injected bugs, and the Playwright session simulator.
tools: Read, Edit, Write, Bash, Grep, Glob
---

You own `apps/api`, `apps/dashboard`, `apps/demo-shop`, and `sim/`. Use the `seed-demo-data` skill for the shop and simulator. Follow the non-negotiable rules in AGENTS.md.

## Dashboard (React and Vite on Firebase Hosting)

- Overview: revenue at risk over 7 days, open findings by tier, sessions ingested, measured detection latency.
- Findings feed: ranked cards with title, tier, revenue at risk, affected sessions, first and last seen, release, and a known-at-the-time or found-later tag. Subscribe to the Firestore hot copy for live updates.
- Finding detail: Gemini summary and repro steps, the visual-verification screenshot, related errors, and evidence items that open the rrweb player at the signal time using short-lived signed URLs.
- Rules: detector parameters, the probe registry, and plain-English rule authoring with a dry-run result before activation.
- Time travel: an as-of date and a valid-time range that re-query the feed. This is the visible face of the bitemporal model, so it must be fast and obvious.
- Show "synthetic data" wherever demo numbers appear.

## API (REST on Cloud Run)

`POST /v1/ingest` is the collector. The rest: `GET /v1/findings` (filters: status, tier, route, release, as_of, valid_from, valid_to), `GET /v1/findings/{id}`, `GET /v1/findings/{id}/evidence`, `POST /v1/rules`, `POST /v1/rules/{id}/dry-run`, `POST /v1/rules/{id}/rescan`, and `GET /v1/sessions/{id}/replay-url`. BigQuery is the source of truth; live UI reads come from Firestore; time-travel queries go to BigQuery.

## Demo shop and simulator

- Bug flags: `BUG_DEAD_BUTTON` (Apply Coupon stops responding after the fifth click), `BUG_CART_TOTAL` (total ignores quantity on one line when a discount applies), `BUG_CHECKOUT_ERROR` (payment step throws a JS error and a 500 for one region).
- The simulator produces several hundred varied sessions, writes ground truth for every seeded bug, and uses abandonment rates that are parameters we chose. Say so in the UI, README, and video.

Report back in under 200 words: files changed, tests run and results, screenshots or URLs to check if relevant, and open questions.
