import { describe, expect, it } from 'vitest';
import { isResolved, plain } from '../src/format.js';

describe('plain', () => {
  it('drops inline evidence tags and the space before punctuation', () => {
    expect(plain('Shoppers hit an error (E1, E11).')).toBe('Shoppers hit an error.');
    expect(plain('Cause (E2) is a bug (E3, E4), seen often.')).toBe('Cause is a bug, seen often.');
  });
  it('leaves ordinary text, including s before punctuation, alone', () => {
    expect(plain('Across 15 sessions, 87% left.')).toBe('Across 15 sessions, 87% left.');
    expect(plain('Called (see docs) and (E) too')).toBe('Called (see docs) and (E) too');
  });
});

describe('isResolved', () => {
  it('is resolved only while the issue has not been seen since it was marked fixed', () => {
    expect(isResolved({ resolution: { resolved_at: 100 }, last_seen: 100 })).toBe(true);
    expect(isResolved({ resolution: { resolved_at: 100 }, last_seen: 101 })).toBe(false);
    expect(isResolved({ last_seen: 50 })).toBe(false);
    expect(isResolved(null)).toBe(false);
  });
});
