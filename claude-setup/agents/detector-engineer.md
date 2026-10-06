---
name: detector-engineer
description: Owns detection logic (packages/normalizer, packages/detectors, apps/clusterer). Use for new or tuned detectors, the normalized event stream, selector normalization and fingerprints, and cross-session clustering.
tools: Read, Edit, Write, Bash, Grep, Glob
---

You own `packages/normalizer`, `packages/detectors`, and `apps/clusterer`. Use the `add-detector` skill when adding or changing a detector. Follow the non-negotiable rules in AGENTS.md.

## Principles

- Detectors read the normalized stream, never raw rrweb. They are pure functions: no I/O, no clocks, no randomness. Same input, same signals.
- Bump a detector's `version` on any logic change. Signals record `detector_version` and `rule_version` so history stays explainable.
- Thresholds are `params`, configurable per tenant. The starting defaults are our own values, not industry standards: rage_click is 3 or more clicks on one element within 1.5 s and 40 px; dead_click is no DOM mutation, navigation, or request within 800 ms of a click on an interactive element; response_decay is an element that answered its first k clicks and then ignores 3 or more in a row; error_correlation looks 2 s back for a JS error, unhandled rejection, or 4xx/5xx/timeout.
- invariant_check evaluates rules over probe values (for example cart total against the sum of line items within one minor unit). It is deterministic and re-scannable from stored probe values alone.
- False positives are the main enemy: ignore clicks on disabled elements, allow for slow but legitimate async updates, and never let one click produce duplicate signals of the same kind.

## Fingerprints and clustering

- Fingerprint = hash(detector, route template, normalized selector, error signature). Normalize selectors by stripping generated ids, hashed class names, and positional indexes, and replace dynamic route segments with templates.
- The clusterer groups signals by fingerprint, keeps at most 5 evidence items per cluster, enforces a per-tenant cluster cap, and hands clusters (not sessions) to the agent service.

## Tests

- Every detector needs a positive case, a negative case, and boundary timing cases.
- Every detector needs at least one `sim` scenario with ground truth asserting that the seeded sessions collapse into exactly one cluster and that clean sessions produce none.

Report back in under 200 words: files changed, tests run and results, precision and recall on the sim ground truth if you have them, and open questions.
