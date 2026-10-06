---
name: add-detector
description: Add or change a detector plugin (rage_click, dead_click, response_decay, invariant_check, error_correlation, or a new one) in packages/detectors. Use when a task touches detection logic, thresholds, or fingerprints.
---

# Add or change a detector

Detectors read the normalized event stream, never raw rrweb. They are pure functions with no I/O, clocks, or randomness.

## Steps

1. State in one sentence what the signal means and which sim scenario proves it. If no scenario exists, add one first (see the `seed-demo-data` skill).
2. Create or edit `packages/detectors/src/<id>.ts` implementing the `Detector` interface from `packages/schema`: `id`, `version`, `params`, and `run(ctx, chunk)` returning `Signal[]`.
3. Bump `version` on any logic change, and record it in each signal as `detector_version`.
4. Register the detector and its default `params` in `packages/detectors/src/index.ts`. Thresholds must be overridable per tenant.
5. Build the fingerprint with the shared helper: hash of detector, route template, normalized selector, and error signature. Normalize selectors by stripping generated ids, hashed class names, and positional indexes, and replace dynamic route segments with templates.
6. Put evidence on the signal as small structured data: `sessionId`, `seq`, `tStart`, `tEnd`, and optionally `selector` and `values`. The dashboard uses it to jump to the replay moment.
7. Write tests in `packages/detectors/test/<id>.test.ts`: a positive case, a negative case, and boundary timing cases (exactly at the threshold, just under, just over).
8. Add or update the sim ground-truth assertion: seeded sessions collapse into exactly one cluster, and clean sessions produce none.
9. Update the detector table in section 4 of `docs/ARCHITECTURE.md` if behavior or defaults changed.
10. Run `pnpm test --filter detectors` and the sim assertion, and report both.

## Starting defaults (our own values, not industry standards)

| Detector | Fires when |
| --- | --- |
| rage_click | 3 or more clicks on the same element within 1.5 s and 40 px |
| dead_click | Click on an interactive element with no DOM mutation, navigation, or request within 800 ms |
| response_decay | An element answered its first k clicks, then 3 or more consecutive clicks get no response |
| invariant_check | A rule over probe values is violated beyond tolerance (for example cart total vs sum of line items by more than 1 minor unit) |
| error_correlation | A JS error, unhandled rejection, or 4xx/5xx/timeout occurs within 2 s before another signal |

## Pitfalls

- Clicks on disabled or non-interactive elements are not dead clicks.
- Slow but legitimate async updates look like dead clicks; use the configured window and check for pending requests.
- One click must not emit duplicate signals of the same kind.
- invariant_check must compare values in integer minor units, never floats.
- A detector that needs a selector nobody probed cannot run from stored data; flag it as a rebuild-path rule instead of faking it.
