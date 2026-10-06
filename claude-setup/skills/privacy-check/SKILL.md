---
name: privacy-check
description: Review a change to the SDK, collector, storage, logging, or LLM inputs for privacy leaks before merge. Use whenever code touches what leaves the browser, what is stored, what is logged, or what is sent to Gemini.
---

# Privacy check

Nothing sensitive should leave the browser, and nothing sensitive should reach Gemini. rrweb's defaults are permissive: `maskAllInputs` is false and only password inputs are masked by default, and a GitHub issue reports hidden inputs escaping `maskAllInputs`. Verify against the pinned rrweb version, and do not rely on client masking alone.

## Checklist

| Layer | Verify |
| --- | --- |
| Capture | `maskAllInputs: true`; `blockSelector` covers payment and identity elements; `maskTextSelector` covers account, address, and order-confirmation text; `maskInputFn` and `maskTextFn` catch emails, phone numbers, and card-like digit runs |
| Probes | Allowlisted selectors only; values parsed to numbers and currency before leaving the browser; no probe text sent as text |
| URLs | Query strings and fragments dropped from `url_path` |
| Network capture | Status, duration, and route template only; no bodies, headers, or query strings |
| Collector | Second-pass scrubber runs before storage; unknown site keys rejected; parse errors fail closed; payloads never logged |
| LLM boundary | Gemini receives structured evidence and screenshots from the already-masked replay, never raw HTML or raw rrweb events |
| Tenancy | `tenant_id` on every row and every query; per-tenant storage prefix; replay URLs are short-lived signed URLs |
| Retention | Lifecycle rule on raw chunks; deletion by session_id works through the `raw_chunks` index |
| Logging | No session content in Cloud Logging or console output; service logs only |
| Region | Bucket, dataset, and services in one region |
| Consent | SDK starts only after the host site signals consent |

## How to verify

1. Run `git diff` for the change and search it for `console.log`, `JSON.stringify` of events, and any code that forwards request or response bodies.
2. Check that a fixture batch containing an email, a phone number, a card-like digit run, and a hidden input comes out scrubbed at the collector. Add the fixture if it does not exist.
3. Confirm no code path passes raw `events` arrays or HTML to an agent.
4. For demo data, confirm the UI and README say the data is synthetic.

## Output

List each violation with file and line, the leak it allows, and the smallest fix. Then list what you checked and found fine. For real customer data, note that consent rules differ by country across JAPAC and legal review is needed before launch; the hackathon build runs on synthetic sessions only.
