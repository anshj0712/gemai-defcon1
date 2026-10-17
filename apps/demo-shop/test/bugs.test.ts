import { describe, expect, it } from 'vitest';
import { BUG_NAMES, CONFLICT_GROUPS, MAX_BUGS, MIN_BUGS, pickSessionBugs } from '../src/bugs';

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

describe('the shop picks a random, compatible set of bugs per session', () => {
  const draws = Array.from({ length: 2000 }, (_, i) => pickSessionBugs(seeded(i + 1)));

  it('never puts two bugs from one conflict group in a session', () => {
    for (const set of draws) {
      for (const group of CONFLICT_GROUPS) expect(set.filter((b) => group.includes(b)).length).toBeLessThanOrEqual(1);
    }
  });

  it('draws none (the baseline) or 2 to 4 distinct known bugs', () => {
    for (const set of draws) {
      expect(new Set(set).size).toBe(set.length);
      expect(set.every((b) => (BUG_NAMES as readonly string[]).includes(b))).toBe(true);
      expect(set.length === 0 || (set.length >= MIN_BUGS && set.length <= MAX_BUGS)).toBe(true);
    }
  });

  it('leaves about one session in five clean and reaches every bug', () => {
    const clean = draws.filter((s) => s.length === 0).length / draws.length;
    expect(clean).toBeGreaterThan(0.15);
    expect(clean).toBeLessThan(0.25);
    const seen = new Set(draws.flat());
    expect(seen.size).toBe(BUG_NAMES.length);
  });

  it('is repeatable for the same random source', () => {
    expect(pickSessionBugs(seeded(42))).toEqual(pickSessionBugs(seeded(42)));
  });
});
