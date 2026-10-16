/**
 * Session plans for the simulator: who each synthetic shopper is, which bug flags are on, and the
 * ground truth for the session (the bug it actually runs into, or none). Pure and seeded: the same
 * seed and count always produce the same plans, whatever the browser timing.
 */

export const BUGS = [
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
export type Bug = (typeof BUGS)[number];

/**
 * Bugs no built-in detector or rule can see: they stay silent (no issue) until a merchant writes a rule
 * that catches them, and a re-scan then finds the sessions they already hurt (Phase 4, found later).
 */
export const RETRO_BUGS: readonly Bug[] = ['qty_price'];

/**
 * Bugs the churn watcher finds on its own: nothing in the declared probes or detectors sees them, but the
 * recording does (a page element nobody probed, or a slow request). The agent proposes a probe and a rule
 * from how much more often affected shoppers leave; once a person approves, a re-scan finds them later
 * (`pnpm sim:watch`).
 */
export const WATCH_BUGS: readonly Bug[] = ['shipping_shock', 'slow_delivery', 'slow_payment', 'slow_stock'];

/** Silent until some rule exists: `sim:check` accepts no issue for these. */
export const SILENT_BUGS: readonly Bug[] = [...RETRO_BUGS, ...WATCH_BUGS];

/**
 * Bugs a clean shopper can carry as a flag without ever reaching it (a near miss). The others trigger on any
 * product view or any order (slow_stock, slow_delivery, shipping_shock, slow_payment, card_declined), so a
 * clean session never carries them.
 */
export const NEAR_MISS_BUGS: readonly Bug[] = ['dead_button', 'cart_total', 'checkout_error', 'qty_price', 'ghost_line', 'returns_hidden', 'support_down', 'recs_sold_out'];

/**
 * Bugs no built-in rule sees but the agent can: the rule suggester reads the recurring issue they cause and
 * proposes a rule, which a person approves (`pnpm sim:suggest`). Its re-scan then builds a second issue (kind
 * invariant, anchored on the approved rule) holding the same sessions; scoring allows that one.
 */
export const SUGGESTED_RULE_BUGS: readonly Bug[] = ['ghost_line'];

/** The sentence `pnpm sim:rescan` gives the rule author; it catches qty_price (and the dashboard offers it). */
export const RETRO_RULE_SENTENCE = 'No pair of shoes costs more than ₹17,000, so the bag subtotal must never be more than ₹17,000 times the number of pairs.';

export type Persona =
  /** dead_button: tries three codes, then the right one, and the button has stopped working. */
  | 'coupon_hunter'
  /** cart_total: ends with 2+ items in the bag (two products, or more of one) and applies SAVE10; the total comes out wrong. */
  | 'bulk_buyer'
  /** checkout_error: pays from the Northeast region, the payment fails, and they retry quickly. */
  | 'northeast_payer'
  /** qty_price: raises a line's quantity to 2+, and the bag shows that line at 100x its price (totals agree with it). */
  | 'pair_buyer'
  /**
   * ghost_line: bags two products, presses Remove on the last line, stares at a line that did not go away
   * (quantity 0, ₹0), then presses Remove again 2 or 3 times fast; it no longer responds. The first line stays,
   * so the bag keeps a real value (qty [1, 0], line_total [price, 0]).
   */
  | 'line_remover'
  /** shipping_shock: reaches checkout, reads a ₹499 delivery fee the bag called free, and usually leaves. */
  | 'fee_shocked'
  /** slow_delivery: reads a 9–12 day delivery estimate on the product page, bags it anyway, and usually leaves. */
  | 'eta_reader'
  /** slow_payment: places an order, waits 6.5 s for the bank, gets a timeout; leaves or tries once more. */
  | 'slow_bank'
  /** slow_stock: waits 4 s for Add to Bag on each shoe; often leaves. */
  | 'stock_waiter'
  /** card_declined: the card is declined; presses Use another card 2 or 3 times (dead) and leaves. */
  | 'declined_card'
  /** returns_hidden: presses Returns policy 2 or 3 times on a product page (dead) before deciding. */
  | 'returns_checker'
  /** support_down: at checkout, presses Chat with us once or twice (it fails), then decides. */
  | 'help_seeker'
  /** recs_sold_out: presses Quick add on a pick in the bag 2 or 3 times (dead). */
  | 'rec_clicker'
  /** Clean: looks at a few products and leaves without a bag. */
  | 'window_shopper'
  /** Clean: bags one or two products, maybe a coupon and a quantity change, then checks out or leaves. */
  | 'buyer';

export interface SimConfig {
  /** Share of sessions that run into each bug; the rest are clean. */
  mix: Record<Bug, number>;
  /** Probability a shopper with a bag leaves without ordering. Affected and baseline differ by design. */
  abandonment: Record<Bug | 'baseline', number>;
  /** Share of clean sessions that are window shoppers (no bag). */
  windowShoppers: number;
  /** Share of clean sessions with one bug flag on whose trigger they never reach (near misses). */
  nearMiss: number;
}

export const DEFAULT_CONFIG: SimConfig = {
  // 13 bugs and about a quarter clean sessions: run 240+ sessions so each bug has a dozen shoppers.
  mix: {
    dead_button: 0.08,
    cart_total: 0.07,
    checkout_error: 0.07,
    qty_price: 0.06,
    ghost_line: 0.06,
    shipping_shock: 0.05,
    slow_delivery: 0.05,
    slow_payment: 0.05,
    slow_stock: 0.05,
    card_declined: 0.05,
    returns_hidden: 0.05,
    support_down: 0.05,
    recs_sold_out: 0.05,
  },
  abandonment: {
    baseline: 0.25,
    dead_button: 0.6,
    cart_total: 0.4,
    checkout_error: 0.85,
    qty_price: 0.7,
    ghost_line: 0.75,
    shipping_shock: 0.8,
    slow_delivery: 0.7,
    slow_payment: 0.75,
    slow_stock: 0.65,
    // Moot: a declined card can never order.
    card_declined: 1,
    returns_hidden: 0.55,
    support_down: 0.7,
    recs_sold_out: 0.5,
  },
  windowShoppers: 0.3,
  nearMiss: 0.5,
};

export const PRODUCT_IDS = ['velocity-runner', 'cloudline-lite', 'court-classic', 'trail-ascent', 'tempo-knit', 'street-mid', 'studio-trainer', 'pace-racer'] as const;
/** UK sizes that are in stock for every product above (see the demo shop catalog). */
export const SAFE_SIZES = ['8.5', '9', '10', '10.5'] as const;
export const REGIONS = ['North', 'South', 'East', 'West', 'Northeast'] as const;
export const INVALID_CODES = ['WELCOME5', 'FIRST20', 'STRIDE15', 'FREESHIP', 'SUMMER10', 'RUN25', 'HELLO10'] as const;

export interface SessionPlan {
  index: number;
  /** Seeds the session's own randomness (jitter, pauses). */
  seed: number;
  persona: Persona;
  /** Ground truth: the bug this session runs into, or null for a clean (baseline) session. */
  bug: Bug | null;
  /** Bug flags switched on. A clean session may carry one it never triggers. */
  flags: Bug[];
  products: { id: string; size: string }[];
  /** Codes tried in order, one press each (coupon_hunter's last press is SAVE10 on a dead button). */
  codes: string[];
  /** Extra presses on Apply Coupon after the last code (coupon_hunter). */
  extraPresses: number;
  /** Ends a run of presses with a fast burst (frustration). */
  rapidBurst: boolean;
  /** Quantity increases on the first line (bulk_buyer: 1 or 2) or on the last line (buyer). */
  qtyIncrements: number;
  incrementFirstLine: boolean;
  region: (typeof REGIONS)[number];
  /** Retries after a failed payment (northeast_payer). */
  retries: number;
  /** Presses on Remove after the first one, as a fast burst on the line that stayed (line_remover: 2 or 3; else 0). */
  removePresses: number;
  /**
   * Presses on the bug's own control: Returns policy (returns_checker), Chat with us (help_seeker), Quick add
   * (rec_clicker), Use another card (declined_card). 0 for everyone else.
   */
  presses: number;
  /** Leaves without ordering once the bag is ready (or after the bug hits). */
  abandon: boolean;
  /** Where an abandoning shopper leaves: on the bag page or partway through checkout. */
  abandonAt: 'bag' | 'checkout';
}

/** mulberry32: small, fast, seedable. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)]!;
const chance = (r: () => number, p: number) => r() < p;

function distinctProducts(r: () => number, n: number): { id: string; size: string }[] {
  const ids = [...PRODUCT_IDS].sort(() => r() - 0.5).slice(0, n);
  return ids.map((id) => ({ id, size: pick(r, SAFE_SIZES) }));
}

/** Exact counts per bug from the mix (rounded), shuffled across the run. */
function assignBugs(r: () => number, sessions: number, mix: Record<Bug, number>): (Bug | null)[] {
  const out: (Bug | null)[] = [];
  for (const bug of BUGS) for (let i = 0; i < Math.round(sessions * mix[bug]); i++) out.push(bug);
  while (out.length < sessions) out.push(null);
  out.length = sessions;
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function makePlans(sessions: number, seed: number, config: SimConfig = DEFAULT_CONFIG): SessionPlan[] {
  const r = rng(seed);
  const bugs = assignBugs(r, sessions, config.mix);
  return bugs.map((bug, index): SessionPlan => {
    const base = {
      index,
      seed: Math.floor(r() * 2 ** 31),
      bug,
      codes: [] as string[],
      extraPresses: 0,
      rapidBurst: false,
      qtyIncrements: 0,
      incrementFirstLine: false,
      retries: 0,
      removePresses: 0,
      presses: 0,
      region: pick(r, REGIONS.filter((x) => x !== 'Northeast')),
      abandonAt: (chance(r, 0.5) ? 'bag' : 'checkout') as SessionPlan['abandonAt'],
    };
    switch (bug) {
      case 'dead_button': {
        // Three wrong codes (presses 1-3 work), then SAVE10 on press 4: the button is dead from there.
        const wrong = [...INVALID_CODES].sort(() => r() - 0.5).slice(0, 3);
        return { ...base, persona: 'coupon_hunter', flags: [bug], products: distinctProducts(r, chance(r, 0.5) ? 1 : 2), codes: [...wrong, 'SAVE10'], extraPresses: chance(r, 0.5) ? 2 : 3, rapidBurst: chance(r, 0.5), abandon: chance(r, config.abandonment.dead_button) };
      }
      case 'cart_total': {
        // 2+ items is the trigger: one product with a higher quantity, or two different products (with or without an extra).
        const products = distinctProducts(r, chance(r, 0.6) ? 1 : 2);
        const qtyIncrements = products.length === 1 ? (chance(r, 0.6) ? 1 : 2) : chance(r, 0.5) ? 0 : 1;
        return { ...base, persona: 'bulk_buyer', flags: [bug], products, codes: ['SAVE10'], qtyIncrements, incrementFirstLine: true, abandon: chance(r, config.abandonment.cart_total) };
      }
      case 'checkout_error':
        return { ...base, persona: 'northeast_payer', flags: [bug], products: distinctProducts(r, chance(r, 0.6) ? 1 : 2), codes: chance(r, 0.3) ? ['SAVE10'] : [], region: 'Northeast', retries: chance(r, 0.5) ? 3 : 4, abandon: chance(r, config.abandonment.checkout_error), abandonAt: 'checkout' };
      case 'qty_price':
        // A higher quantity on the first line is the trigger; no coupon, so no other rule is involved.
        return { ...base, persona: 'pair_buyer', flags: [bug], products: distinctProducts(r, chance(r, 0.6) ? 1 : 2), qtyIncrements: chance(r, 0.6) ? 1 : 2, incrementFirstLine: true, abandon: chance(r, config.abandonment.qty_price) };
      case 'ghost_line':
        // Remove on the last of two lines (quantity 1) is the trigger; no coupon and no quantity change, so no other rule
        // is involved, and the line that stays keeps the bag's value above zero.
        return { ...base, persona: 'line_remover', flags: [bug], products: distinctProducts(r, 2), removePresses: chance(r, 0.5) ? 2 : 3, abandon: chance(r, config.abandonment.ghost_line), abandonAt: 'bag' };
      // The churn-reason bugs: no coupon and no quantity change, so no other rule or bug is involved.
      case 'shipping_shock':
        // The fee shows at checkout, so an abandoning shopper leaves there, after reading it.
        return { ...base, persona: 'fee_shocked', flags: [bug], products: distinctProducts(r, chance(r, 0.6) ? 1 : 2), abandon: chance(r, config.abandonment.shipping_shock), abandonAt: 'checkout' };
      case 'slow_delivery':
        return { ...base, persona: 'eta_reader', flags: [bug], products: distinctProducts(r, chance(r, 0.6) ? 1 : 2), abandon: chance(r, config.abandonment.slow_delivery) };
      case 'slow_payment':
        // Every one of them places an order and meets the slow bank; abandoning ones leave after the timeout.
        return { ...base, persona: 'slow_bank', flags: [bug], products: distinctProducts(r, chance(r, 0.6) ? 1 : 2), abandon: chance(r, config.abandonment.slow_payment), abandonAt: 'checkout' };
      case 'slow_stock':
        return { ...base, persona: 'stock_waiter', flags: [bug], products: distinctProducts(r, chance(r, 0.6) ? 1 : 2), abandon: chance(r, config.abandonment.slow_stock) };
      case 'card_declined':
        return { ...base, persona: 'declined_card', flags: [bug], products: distinctProducts(r, chance(r, 0.6) ? 1 : 2), presses: chance(r, 0.5) ? 2 : 3, abandon: true, abandonAt: 'checkout' };
      case 'returns_hidden':
        return { ...base, persona: 'returns_checker', flags: [bug], products: distinctProducts(r, chance(r, 0.6) ? 1 : 2), presses: chance(r, 0.5) ? 2 : 3, abandon: chance(r, config.abandonment.returns_hidden) };
      case 'support_down':
        return { ...base, persona: 'help_seeker', flags: [bug], products: distinctProducts(r, chance(r, 0.6) ? 1 : 2), presses: chance(r, 0.5) ? 1 : 2, abandon: chance(r, config.abandonment.support_down), abandonAt: 'checkout' };
      case 'recs_sold_out':
        return { ...base, persona: 'rec_clicker', flags: [bug], products: distinctProducts(r, 1), presses: chance(r, 0.5) ? 2 : 3, abandon: chance(r, config.abandonment.recs_sold_out) };
      default: {
        // Clean. A near miss carries one bug flag but stays clear of its trigger.
        const flags: Bug[] = chance(r, config.nearMiss) ? [pick(r, NEAR_MISS_BUGS)] : [];
        if (chance(r, config.windowShoppers)) {
          return { ...base, persona: 'window_shopper', flags, products: distinctProducts(r, 1 + Math.floor(r() * 3)), abandon: true, abandonAt: 'bag' };
        }
        const bagged = distinctProducts(r, chance(r, 0.5) ? 1 : 2);
        const codes = chance(r, 0.5) ? (chance(r, 0.3) ? [pick(r, INVALID_CODES), 'SAVE10'] : ['SAVE10']) : [];
        // With cart_total on, a discounted bag must stay at a single item (2+ items is the trigger).
        const guard = flags.includes('cart_total') && codes.includes('SAVE10');
        const products = guard ? bagged.slice(0, 1) : bagged;
        const incrementFirstLine = !guard && chance(r, 0.5);
        // With qty_price on, every quantity stays at 1 (a quantity of 2 is its trigger).
        const qtyIncrements = guard || flags.includes('qty_price') ? 0 : chance(r, 0.4) ? 1 + Math.floor(r() * 2) : 0;
        const region = flags.includes('checkout_error') ? base.region : pick(r, REGIONS);
        return { ...base, persona: 'buyer', flags, products, codes, qtyIncrements, incrementFirstLine, region, abandon: chance(r, config.abandonment.baseline) };
      }
    }
  });
}

/** Only line_remover presses Remove; every other shopper only raises quantities, so ghost_line near misses stay clean. */
export const pressesRemove = (p: Pick<SessionPlan, 'persona'>) => p.persona === 'line_remover';

/** Quantity changes land on the first line when asked to, or when it is the only line. */
export const touchesFirstLine = (p: Pick<SessionPlan, 'incrementFirstLine' | 'products'>) => p.incrementFirstLine || p.products.length === 1;

/** The bug a plan's actions reach, if any. Used by tests to keep the ground truth honest. */
export function reachesTrigger(p: SessionPlan): Bug | null {
  if (p.flags.includes('dead_button') && p.codes.length + p.extraPresses > 3) return 'dead_button';
  if (p.flags.includes('cart_total') && p.codes.includes('SAVE10') && p.products.length + p.qtyIncrements >= 2) return 'cart_total';
  if (p.flags.includes('checkout_error') && p.region === 'Northeast' && p.persona !== 'window_shopper' && !(p.abandon && p.abandonAt === 'bag')) return 'checkout_error';
  if (p.flags.includes('qty_price') && p.persona !== 'window_shopper' && p.qtyIncrements > 0) return 'qty_price';
  if (p.flags.includes('ghost_line') && pressesRemove(p)) return 'ghost_line';
  // Every shopper opens a product page, which shows the delivery estimate and runs the stock check.
  if (p.flags.includes('slow_delivery')) return 'slow_delivery';
  if (p.flags.includes('slow_stock')) return 'slow_stock';
  if (p.flags.includes('shipping_shock') && reachesCheckout(p)) return 'shipping_shock';
  if (p.flags.includes('slow_payment') && placesOrder(p)) return 'slow_payment';
  if (p.flags.includes('card_declined') && placesOrder(p)) return 'card_declined';
  if (p.flags.includes('returns_hidden') && p.persona === 'returns_checker' && p.presses > 0) return 'returns_hidden';
  if (p.flags.includes('support_down') && p.persona === 'help_seeker' && p.presses > 0) return 'support_down';
  if (p.flags.includes('recs_sold_out') && p.persona === 'rec_clicker' && p.presses > 0) return 'recs_sold_out';
  return null;
}

/** The shopper gets as far as the checkout page (a bag, and not leaving from the bag). */
export const reachesCheckout = (p: Pick<SessionPlan, 'persona' | 'abandon' | 'abandonAt'>) => p.persona !== 'window_shopper' && !(p.abandon && p.abandonAt === 'bag');

/**
 * The shopper presses Place Order at least once. Abandoning shoppers who reach checkout leave before ordering,
 * except the personas whose story is the payment step itself.
 */
export const placesOrder = (p: Pick<SessionPlan, 'persona' | 'abandon' | 'abandonAt'>) =>
  p.persona === 'northeast_payer' || p.persona === 'slow_bank' || p.persona === 'declined_card' || (reachesCheckout(p) && !p.abandon);
