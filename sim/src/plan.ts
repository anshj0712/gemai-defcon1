/**
 * Session plans for the simulator: who each synthetic shopper is, which bug flags are on, and the
 * ground truth for the session (the bug it actually runs into, or none). Pure and seeded: the same
 * seed and count always produce the same plans, whatever the browser timing.
 */

export const BUGS = ['dead_button', 'cart_total', 'checkout_error', 'qty_price', 'ghost_line'] as const;
export type Bug = (typeof BUGS)[number];

/**
 * Bugs no built-in detector or rule can see: they stay silent (no issue) until a merchant writes a rule
 * that catches them, and a re-scan then finds the sessions they already hurt (Phase 4, found later).
 */
export const RETRO_BUGS: readonly Bug[] = ['qty_price'];

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
  mix: { dead_button: 0.2, cart_total: 0.15, checkout_error: 0.15, qty_price: 0.1, ghost_line: 0.1 },
  abandonment: { baseline: 0.25, dead_button: 0.6, cart_total: 0.4, checkout_error: 0.85, qty_price: 0.7, ghost_line: 0.75 },
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
      default: {
        // Clean. A near miss carries one bug flag but stays clear of its trigger.
        const flags: Bug[] = chance(r, config.nearMiss) ? [pick(r, BUGS)] : [];
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
  return null;
}
