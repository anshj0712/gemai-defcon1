import { describe, expect, it } from 'vitest';
import { BUG_NAMES, CONFLICT_GROUPS, CRUCIAL_BUGS, pickSessionBugs, type Bug } from '../src/bugs';

/** A small seeded generator (mulberry32), so the draws are repeatable. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('every shop session runs the five crucial bugs, plus a random set of the others', () => {
  const draws = Array.from({ length: 2000 }, (_, i) => pickSessionBugs(seeded(i + 1)));
  const others = BUG_NAMES.filter((b) => !CRUCIAL_BUGS.includes(b) && !CONFLICT_GROUPS.some((g) => g.includes(b) && g.some((c) => CRUCIAL_BUGS.includes(c))));

  it('always includes the five crucial bugs, and never a bug that clashes with one', () => {
    expect(CRUCIAL_BUGS).toEqual(['slow_payment', 'checkout_error', 'card_declined', 'cart_total', 'shipping_shock']);
    for (const set of draws) {
      for (const bug of CRUCIAL_BUGS) expect(set).toContain(bug);
      for (const group of CONFLICT_GROUPS) expect(set.filter((b) => group.includes(b)).length).toBeLessThanOrEqual(1);
      expect(set).not.toContain('qty_price' satisfies Bug);
    }
  });

  it('draws distinct known bugs, each other compatible bug about half the time', () => {
    for (const set of draws) {
      expect(new Set(set).size).toBe(set.length);
      expect(set.every((b) => (BUG_NAMES as readonly string[]).includes(b))).toBe(true);
    }
    expect(others).toHaveLength(7);
    for (const bug of others) {
      const share = draws.filter((s) => s.includes(bug)).length / draws.length;
      expect(share).toBeGreaterThan(0.4);
      expect(share).toBeLessThan(0.6);
    }
  });

  it('is repeatable for the same random source', () => {
    expect(pickSessionBugs(seeded(42))).toEqual(pickSessionBugs(seeded(42)));
  });
});
