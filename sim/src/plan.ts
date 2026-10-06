/**
 * Session plans for the simulator: who each synthetic shopper is, which bug flags are on, and the
 * ground truth for the session (the bug it actually runs into, or none). Pure and seeded: the same
 * seed and count always produce the same plans, whatever the browser timing.
 */

export const BUGS = ['dead_button', 'cart_total', 'checkout_error'] as const;
export type Bug = (typeof BUGS)[number];

export type Persona =
  /** dead_button: tries five codes, then the right one, and the button has stopped working. */
  | 'coupon_hunter'
  /** cart_total: raises the quantity of the first line and applies SAVE10; the total comes out wrong. */
  | 'bulk_buyer'
  /** checkout_error: pays from the Northeast region, the payment fails, and they retry quickly. */
  | 'northeast_payer'
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
  mix: { dead_button: 0.2, cart_total: 0.15, checkout_error: 0.15 },
  abandonment: { baseline: 0.25, dead_button: 0.6, cart_total: 0.4, checkout_error: 0.85 },
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
      region: pick(r, REGIONS.filter((x) => x !== 'Northeast')),
      abandonAt: (chance(r, 0.5) ? 'bag' : 'checkout') as SessionPlan['abandonAt'],
    };
    switch (bug) {
      case 'dead_button': {
        // Five wrong codes (presses 1-5 work), then SAVE10 on press 6: the button is dead from there.
        const wrong = [...INVALID_CODES].sort(() => r() - 0.5).slice(0, 5);
        return { ...base, persona: 'coupon_hunter', flags: [bug], products: distinctProducts(r, chance(r, 0.5) ? 1 : 2), codes: [...wrong, 'SAVE10'], extraPresses: chance(r, 0.5) ? 2 : 3, rapidBurst: chance(r, 0.5), abandon: chance(r, config.abandonment.dead_button) };
      }
      case 'cart_total':
        return { ...base, persona: 'bulk_buyer', flags: [bug], products: distinctProducts(r, chance(r, 0.6) ? 1 : 2), codes: ['SAVE10'], qtyIncrements: chance(r, 0.6) ? 1 : 2, incrementFirstLine: true, abandon: chance(r, config.abandonment.cart_total) };
      case 'checkout_error':
        return { ...base, persona: 'northeast_payer', flags: [bug], products: distinctProducts(r, chance(r, 0.6) ? 1 : 2), codes: chance(r, 0.3) ? ['SAVE10'] : [], region: 'Northeast', retries: chance(r, 0.5) ? 3 : 4, abandon: chance(r, config.abandonment.checkout_error), abandonAt: 'checkout' };
      default: {
        // Clean. A near miss carries one bug flag but stays clear of its trigger.
        const flags: Bug[] = chance(r, config.nearMiss) ? [pick(r, BUGS)] : [];
        if (chance(r, config.windowShoppers)) {
          return { ...base, persona: 'window_shopper', flags, products: distinctProducts(r, 1 + Math.floor(r() * 3)), abandon: true, abandonAt: 'bag' };
        }
        const products = distinctProducts(r, chance(r, 0.5) ? 1 : 2);
        const codes = chance(r, 0.5) ? (chance(r, 0.3) ? [pick(r, INVALID_CODES), 'SAVE10'] : ['SAVE10']) : [];
        // With cart_total on, a discounted first line must stay at quantity 1 (that is the trigger).
        const guard = flags.includes('cart_total') && codes.includes('SAVE10');
        const incrementFirstLine = !guard && chance(r, 0.5);
        const qtyIncrements = guard && products.length === 1 ? 0 : chance(r, 0.4) ? 1 + Math.floor(r() * 2) : 0;
        const region = flags.includes('checkout_error') ? base.region : pick(r, REGIONS);
        return { ...base, persona: 'buyer', flags, products, codes, qtyIncrements, incrementFirstLine, region, abandon: chance(r, config.abandonment.baseline) };
      }
    }
  });
}

/** Quantity changes land on the first line when asked to, or when it is the only line. */
export const touchesFirstLine = (p: Pick<SessionPlan, 'incrementFirstLine' | 'products'>) => p.incrementFirstLine || p.products.length === 1;

/** The bug a plan's actions reach, if any. Used by tests to keep the ground truth honest. */
export function reachesTrigger(p: SessionPlan): Bug | null {
  if (p.flags.includes('dead_button') && p.codes.length + p.extraPresses > 5) return 'dead_button';
  if (p.flags.includes('cart_total') && p.codes.includes('SAVE10') && touchesFirstLine(p) && p.qtyIncrements > 0) return 'cart_total';
  if (p.flags.includes('checkout_error') && p.region === 'Northeast' && p.persona !== 'window_shopper' && !(p.abandon && p.abandonAt === 'bag')) return 'checkout_error';
  return null;
}
