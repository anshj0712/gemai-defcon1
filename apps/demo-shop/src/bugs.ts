/** The demo shop's thirteen bugs (descriptions in main.ts and docs/DEMO_BUGS.md). */
export const BUG_NAMES = [
  'dead_button',
  'cart_total',
  'checkout_error',
  'qty_price',
  'ghost_line',
  'shipping_shock',
  'slow_delivery',
  'slow_payment',
  'slow_stock',
  'card_declined',
  'returns_hidden',
  'support_down',
  'recs_sold_out',
] as const;
export type Bug = (typeof BUG_NAMES)[number];
export const isBug = (s: string): s is Bug => (BUG_NAMES as readonly string[]).includes(s);

/**
 * Bugs that hide each other, so a session gets at most one from each group:
 *   - the payment step: a declined card, a 500 for Northeast, and a bank timeout each stop the order before the
 *     others can show;
 *   - the bag totals: both rewrite the line or total amounts, and together they would blur which rule caught what.
 * The other eight touch different controls and combine freely.
 */
export const CONFLICT_GROUPS: readonly (readonly Bug[])[] = [
  ['checkout_error', 'card_declined', 'slow_payment'],
  ['cart_total', 'qty_price'],
];

/** Share of sessions with no bug at all: the baseline that revenue at risk and the churn watcher compare against. */
export const CLEAN_SHARE = 0.2;
export const MIN_BUGS = 2;
export const MAX_BUGS = 4;

/**
 * A random, compatible set of bugs for one shopper's session: none (about 1 in 5), or 2 to 4 bugs with at most one
 * from each conflict group. `random` is injectable so tests can seed it.
 */
export function pickSessionBugs(random: () => number = Math.random): Bug[] {
  if (random() < CLEAN_SHARE) return [];
  const size = MIN_BUGS + Math.floor(random() * (MAX_BUGS - MIN_BUGS + 1));
  const pool = [...BUG_NAMES];
  // Fisher-Yates shuffle.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const picked: Bug[] = [];
  for (const bug of pool) {
    if (picked.length >= size) break;
    const group = CONFLICT_GROUPS.find((g) => g.includes(bug));
    if (group && picked.some((p) => group.includes(p))) continue;
    picked.push(bug);
  }
  return picked;
}
