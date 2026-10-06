---
name: seed-demo-data
description: Run or extend the demo shop and the Playwright session simulator that seeds synthetic sessions with known bugs and ground truth. Use for demo prep, detector precision and recall checks, and the retroactive re-scan demo.
---

# Demo shop and session simulator

All demo data is synthetic. Say so in the dashboard, the README, and the video.

## Demo shop (`apps/demo-shop`)

The shop has a product list, product page, cart with coupon, and checkout. Bugs are switched by flags, so the same build produces clean and buggy sessions:

| Flag | Behavior |
| --- | --- |
| `BUG_DEAD_BUTTON` | Apply Coupon silently stops responding after the fifth click |
| `BUG_CART_TOTAL` | Cart total ignores quantity on one line when a discount applies, so it differs from the sum of line items |
| `BUG_CHECKOUT_ERROR` | Payment step throws a JS error and a 500 for one region, producing rage clicks and abandonment |
| `BUG_COUPON_BANNER` (retro demo) | Banner promises a discount but the total does not change. No default rule catches it, so the plain-English rule added during the demo finds it in past sessions |

The shop installs the SDK with one script tag and registers probes for cart total, line-item price, quantity, and discount.

## Simulator (`sim/`)

- Playwright scripts drive the shop with varied behavior: viewport, typing speed, browsing paths, hesitation, and some sessions with no bug flag hit.
- Parameters (planned CLI): number of sessions, share of sessions that hit each bug, abandonment probability for affected versus baseline sessions, and the random seed for reproducibility. These probabilities are our choices, so keep them in one config file and print them at the start of every run.
- Output: sessions flow through the real SDK to the collector. Also write `sim/out/ground-truth.json` listing session ids per seeded bug.
- Run with `pnpm sim -- --sessions 500` (planned; create it in Phase 0 if it does not exist yet).

## Using it

1. Detector work: after seeding, assert each bug collapses into exactly one cluster and clean sessions produce none. Report precision and recall against `ground-truth.json`.
2. Retroactive demo: seed sessions with `BUG_COUPON_BANNER` but no rule covering it. Confirm nothing is found. Add the plain-English rule, dry-run, approve, re-scan, and confirm the finding appears tagged found-later with the right session count.
3. Demo video: run from pre-seeded data plus one live click sequence (six clicks on Apply Coupon), on pre-warmed services.

## Notes

- Playwright works on Windows; keep scripts in TypeScript and avoid shell-specific commands.
- Keep session generation deterministic by seed so a failing check can be reproduced.
- Never point the simulator at real customer sites.
