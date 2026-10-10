import { describe, expect, it } from 'vitest';
import { plain } from '../src/format.js';

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
