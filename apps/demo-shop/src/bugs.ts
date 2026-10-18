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
 * The five crucial bugs, live in every shopper's session: the money path from the bag to payment. The three payment
 * bugs take turns rather than hiding each other (the store's backend answers the 1st try with a bank timeout, the 2nd
 * with a decline, and lets the 3rd through to checkout, where a Northeast order fails).
 */
export const CRUCIAL_BUGS: readonly Bug[] = ['slow_payment', 'checkout_error', 'card_declined', 'cart_total', 'shipping_shock'];

/**
 * Bugs that hide each other, so a session never gets both: they rewrite the same bag amounts, and together they would
 * blur which rule caught what. With cart_total crucial, qty_price only runs when a script forces it with ?bugs=.
 */
export const CONFLICT_GROUPS: readonly (readonly Bug[])[] = [['cart_total', 'qty_price']];

/** The chance that each of the other bugs is live in a session, unless it clashes with one already picked. */
export const OTHER_BUG_CHANCE = 0.5;

/**
 * The bugs for one shopper's session: the five crucial ones, plus each other compatible bug with an even chance.
 * `random` is injectable so tests can seed it.
 */
export function pickSessionBugs(random: () => number = Math.random): Bug[] {
  const picked: Bug[] = [...CRUCIAL_BUGS];
  for (const bug of BUG_NAMES) {
    if (picked.includes(bug)) continue;
    const group = CONFLICT_GROUPS.find((g) => g.includes(bug));
    if (group && picked.some((p) => group.includes(p))) continue;
    if (random() < OTHER_BUG_CHANCE) picked.push(bug);
  }
  return picked;
}
