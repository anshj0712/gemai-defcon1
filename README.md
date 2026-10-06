# Churn Preventer Agent

Finds friction and silent data bugs in checkout sessions recorded with rrweb, and ranks them by revenue at risk. Built for the Google Cloud AI Builder Cup 2026 (Retail & Commerce). Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Rules for contributors and agents: [`AGENTS.md`](AGENTS.md).

**All demo data is synthetic.** Sessions come from the test kit and the simulator, never from real shoppers.

## What runs today (Phase 2: detectors, live issues, simulator)

```text
SDK batch ──POST /v1/ingest──> collector ──raw chunk──> Cloud Storage (immutable)
  (rrweb, masking, probes)         └──metadata──> Pub/Sub events.raw (ordering key = session_id)
                                                      └──push──> processor: normalize -> dead_click, rage_click,
                                                                 response_decay, invariant_check, then error_correlation
                                                                   ├──> BigQuery raw_chunks, business_events, signals
                                                                   ├──> Firestore session tail (+ detector state)
                                                                   └──> Pub/Sub signals ──push──> clusterer
                                                                                                    └──> Firestore issues
API (:8082) ──> dashboard (:5174): live Issues feed, issue pages, signals, session replay with the flagged moment
Logs: pretty in your terminal, structured JSON on Cloud Run -> Cloud Logging, `pnpm logs:tail` back to your terminal.
```

The clusterer turns many sessions into one issue per broken thing. All the symptoms of one control (dead clicks, rage clicks, "stopped responding", and the errors just before them) share an issue keyed by route and element. Data-rule violations share an issue keyed by rule.

## Requirements

- Node 22 or newer, pnpm 12 (`npm i -g pnpm@12`)
- For GCP only: the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) (`winget install Google.CloudSDK` on Windows)

## 1. Local mode: no GCP, no keys

```powershell
pnpm install
pnpm dev      # collector :8080, processor :8081, api :8082, clusterer :8083, shop :5173, dashboard :5174; one merged log stream
pnpm smoke    # in a second terminal: sends a synthetic Apply Coupon session, waits for dead_click signals
```

`pnpm smoke` prints `PASS: 2 signal rows within ~1s`. In local mode, `.data/` stands in for GCP:

| GCP service | Local stand-in |
| --- | --- |
| Cloud Storage | `.data/gcs/` (gzipped chunks) |
| Pub/Sub | `.data/pubsub/*.jsonl` plus HTTP push to the processor and clusterer, retried |
| BigQuery | `.data/bq/<table>.jsonl` |
| Firestore | `.data/firestore/` (session tails, markers, issues) |

`pnpm clean` deletes `.data/`.

## See a flagged moment replayed (local, synthetic)

1. Run `pnpm dev`. It starts the collector, processor, clusterer, API, demo shop, and dashboard, with all logs in one stream.
2. Open **http://localhost:5173/?bugs=dead_button**. This is STRIDE, a fictional sneaker store with synthetic data.
   1. Accept the banner.
   2. Open a shoe, pick a size, and press **Add to Bag**.
   3. Open the **Bag**, type `SAVE10`, and press **Apply Coupon** 6 or more times, about a second apart. From the 6th press on, the button silently does nothing.
3. Watch the replay in either place:
   - In the shop, open **Demo controls** (bottom left) and press **Watch this session's replay**. This works for any session, flagged or not.
   - Open the dashboard at **http://localhost:5174**. It opens on **Issues**, the live feed, which refreshes every 3 s. Open "Unresponsive button#apply-coupon on /cart" and press **Watch replay** on any occurrence. **Signals** lists every raw detector hit.

   You get a short clip of the shopper's pointer leading up to the flagged press: a blue ring with a trail, and clicks flash. The Apply Coupon button is outlined in red, with a caption saying what went wrong. Flags are red marks on the timeline.
   - The other two bugs (switch them on in **Demo controls**, or with the URL):

     | Bug | URL | What to do | Issue it opens |
     | --- | --- | --- | --- |
     | cart_total | `?bugs=cart_total` | In the Bag, press **+** on the first line, then apply `SAVE10` | "Cart total doesn't match its line items" (invariant_check) |
     | checkout_error | `?bugs=checkout_error` | At checkout, choose region **Northeast**, then press **Place Order** 3 or 4 times quickly | "Failing button#place-order on /checkout" (rage_click and error_correlation) |
   - The Demo controls panel is tester tooling. It is excluded from recording, so it never appears in replays or triggers detectors.
4. `pnpm e2e` does all of this in a real Chrome (your installed Chrome with a throwaway profile). It checks:
   - the dead clicks, their route and shared fingerprint
   - the replay flags and the red outline
   - that nothing typed at checkout is stored
   - that the session joins exactly one issue

   It saves screenshots to `sim/out/`, including the Issues feed and the issue page.

## Simulate a few hundred shoppers (the Phase 2 exit test, synthetic)

With `pnpm dev` running:

```powershell
pnpm sim -- --sessions 300 --seed 42 --concurrency 8   # about 12 minutes; watch the Issues feed fill in live
pnpm sim:check                                          # scores the issues against the ground truth
```

The simulator drives the shop in real Chrome. It runs a seeded mix: 20% dead_button, 15% cart_total, 15% checkout_error, and 50% clean shoppers. Half of the clean shoppers have a bug flag on but never reach its trigger.

It writes the ground truth to `sim/out/ground-truth.json`, recording for each session its bug, persona, cart value, and whether it ordered or abandoned.

`pnpm sim:check` passes when all of these hold:

- each bug collapses into exactly one issue;
- precision is 100% and recall is at least 90%;
- no clean session is in any issue;
- there are no stray issues.

It also prints abandonment for affected and baseline shoppers. Those rates are synthetic by design, and Phase 3 turns them into revenue at risk.

## 2. Your laptop against real GCP: supply the keys

1. Create a GCP project with billing enabled.
2. `copy .env.example .env`, then set:
   - `GCP_PROJECT_ID`: your project id.
   - `GCP_REGION`: default `asia-south1`.
   - `SITE_KEYS`: the SDK keys you accept, e.g. `{"pk_test_demo":"demo"}`.
   - `GOOGLE_API_KEY`: optional now, used from Phase 3 (Gemini).
3. Authenticate. Either run `gcloud auth login` and then `gcloud auth application-default login`, or set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account key stored outside the repo.
4. `pnpm infra:up` (add `-- --dry-run` to preview). This creates everything in one region and is safe to re-run:
   - APIs and the Artifact Registry
   - service accounts with least-privilege IAM
   - Firestore with TTL
   - Pub/Sub topics, the ordered `events.raw.processor` subscription and the `signals.clusterer` subscription, both dead-lettered
   - the Firestore index behind the Issues feed
   - a private bucket with 30-day retention
   - the BigQuery dataset, tables and views
   - the `site-keys` and `gemini-api-key` secrets
5. In `.env`, set `CP_MODE=gcp`, `PROCESSOR_PULL=true`, `CLUSTERER_PULL=true`, and `LOG_TO_CLOUD=true`.
6. Run `pnpm dev`, then `pnpm smoke`. The signal rows now land in BigQuery, and the logs appear in your terminal and in the GCP console (log name `cp-local`).

## 3. Deploy to Cloud Run

```powershell
pnpm deploy:collector            # build + test gate, Cloud Build image, Cloud Run (public; site-key auth)
pnpm deploy:processor            # private; switches events.raw.processor to authenticated push
pnpm deploy:clusterer            # private; switches signals.clusterer to authenticated push
pnpm smoke -- --collector https://cp-collector-....run.app
pnpm logs:tail                   # stream the services' Cloud Logging entries into your terminal
pnpm logs:tail -- --service processor --since 1h
```

Each deploy prints a Logs Explorer link. Services scale to zero by default. Use `-- --min 1` on demo day to avoid cold starts.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Install the workspace |
| `pnpm build` | Compile every package (`tsc -b`) |
| `pnpm typecheck` | Build plus type-check tests and scripts |
| `pnpm test` | All unit tests (Vitest); `pnpm --filter @cp/detectors test` for one package |
| `pnpm dev` | Collector, processor, clusterer, API, demo shop (:5173), and dashboard (:5174), with watch mode and merged logs |
| `pnpm e2e` | Real-browser check: shop -> signals -> one issue -> replay pinpoints the dead click (screenshots in `sim/out/`) |
| `pnpm sim` | Synthetic shoppers with ground truth (`-- --sessions 300 --seed 42 --concurrency 8`) |
| `pnpm sim:check` | Phase 2 exit test: scores the issues against the last run's ground truth |
| `pnpm build:sdk` | Build the one-tag SDK bundle (`apps/sdk/bundle/cp-sdk.js`) |
| `pnpm smoke` | Phase 1 exit test on a synthetic session |
| `pnpm infra:up` | Create or update all GCP resources (`-- --dry-run` to preview) |
| `pnpm deploy:collector`, `deploy:processor`, `deploy:clusterer` | Deploy to Cloud Run (`-- --min 1`, `--skip-tests`, `--dry-run`) |
| `pnpm logs:tail` | Stream Cloud Logging into the terminal (`--service`, `--source cloud_run\|local`, `--since 10m`) |
| `pnpm clean` | Delete local-mode data |

## Privacy

- **Nothing sensitive is stored.** The collector scrubs every batch again before storing it: emails, phone numbers, card-like digit runs, every input `value` (hidden inputs included), typed text, textarea contents, and URL query strings.
- **Probes send numbers, not text.** The cart total, line totals, discount, and quantities are parsed to numbers in the browser; only allowlisted probe selectors are read.
- **Logs carry no payloads.** They hold ids, counts, timings, detectors, fingerprints and selectors only, and a redaction list censors payload keys as a backstop.
- **Gemini sees no raw sessions.** From Phase 3 it receives structured evidence only.
