import { describe, expect, it } from 'vitest';
import { InvariantRuleSchema, type Expr, type InvariantRule } from '@cp/schema';
import { BUILTIN_RULES, checkRule, evaluate, invariantCheck } from '../src/index.js';
import { T, probe, run } from './helpers.js';

/** Two lines (₹10,795 and 2 × ₹8,295) with SAVE10 applied. */
const lines = [1079500, 1659000];
const subtotal = 2738500;
const discount = 273850;
const consistent = { line_total: lines, discount: [discount], cart_total: [subtotal - discount] };
/** The cart_total bug: the first line's quantity ignored after a discount (here the second line has qty 2). */
const buggy = { line_total: lines, discount: [discount], cart_total: [2117615] };

describe('invariant_check', () => {
  it('stays quiet when the total matches its lines', () => {
    expect(run(invariantCheck, [probe(T + 1000, consistent)]).signals).toEqual([]);
  });

  it('reports a total that does not match, with the numbers that prove it', () => {
    const [signal] = run(invariantCheck, [probe(T + 1000, buggy)]).signals;
    expect(signal).toMatchObject({
      detector: 'invariant_check',
      eventTime: T + 1000,
      ruleVersion: 'cart_total_matches_lines@1',
      evidence: { route: '/cart', values: { rule_id: 'cart_total_matches_lines', expected: subtotal - discount, actual: 2117615, delta: 2117615 - (subtotal - discount), highlight_probe: 'cart_total' } },
    });
    expect(signal?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('allows one minor unit of rounding, not two', () => {
    expect(run(invariantCheck, [probe(T + 1000, { ...consistent, cart_total: [subtotal - discount + 1] })]).signals).toEqual([]);
    expect(run(invariantCheck, [probe(T + 1000, { ...consistent, cart_total: [subtotal - discount + 2] })]).signals).toHaveLength(1);
  });

  it('reports one bad state once, a different bad state again, and a recurrence after a fix', () => {
    const other = { ...buggy, cart_total: [2000000] };
    const events = [probe(T + 1000, buggy), probe(T + 2000, buggy), probe(T + 3000, other), probe(T + 4000, consistent), probe(T + 5000, buggy)];
    expect(run(invariantCheck, events).signals.map((s) => s.eventTime)).toEqual([T + 1000, T + 3000, T + 5000]);
  });

  it('does not repeat a reported state in the next chunk', () => {
    const first = run(invariantCheck, [probe(T + 1000, buggy)]);
    expect(run(invariantCheck, [probe(T + 6000, buggy)], { state: first.state }).signals).toEqual([]);
  });

  it('skips pages where the rule’s probes are not present', () => {
    expect(run(invariantCheck, [probe(T + 1000, { cart_total: [123] }, '/product/velocity-runner')]).signals).toEqual([]);
  });

  it('judges each snapshot once: probes in the tail were judged in an earlier chunk', () => {
    expect(run(invariantCheck, [], { tail: [probe(T + 1000, buggy)] }).signals).toEqual([]);
  });

  it('accepts tenant rules with other operators and route scopes', () => {
    const rule: InvariantRule = InvariantRuleSchema.parse({
      id: 'max_items',
      version: 3,
      title: 'Too many items',
      routes: ['/cart'],
      requires: ['qty'],
      assert: { left: { sum: 'qty' }, op: 'lte', right: { const: 10 } },
    });
    const events = [probe(T + 1000, { qty: [6, 6] }), probe(T + 2000, { qty: [6, 6] }, '/checkout')];
    const signals = run(invariantCheck, events, { rules: [rule] }).signals;
    expect(signals).toHaveLength(1);
    expect(signals[0]?.ruleVersion).toBe('max_items@3');
  });
});

describe('rule expressions', () => {
  const values = { a: [3, 4], b: [10], neg: [-5] };

  it.each([
    [{ probe: 'a' }, 3],
    [{ probe: 'a', index: 1 }, 4],
    [{ probe: 'missing', default: 0 }, 0],
    [{ sum: 'a' }, 7],
    [{ count: 'a' }, 2],
    [{ abs: { probe: 'neg' } }, 5],
    [{ add: [{ sum: 'a' }, { probe: 'b' }] }, 17],
    [{ sub: [{ probe: 'b' }, { sum: 'a' }] }, 3],
    [{ mul: [{ probe: 'b' }, { const: 3 }] }, 30],
  ] as [Expr, number][])('%j = %d', (expr, expected) => {
    expect(evaluate(expr, values)).toBe(expected);
  });

  it('returns null for a missing probe with no default', () => {
    expect(evaluate({ probe: 'missing' }, values)).toBeNull();
    expect(evaluate({ add: [{ probe: 'missing' }, { const: 1 }] }, values)).toBeNull();
  });

  it('the built-in rules are valid rule JSON', () => {
    for (const rule of BUILTIN_RULES) expect(InvariantRuleSchema.parse(rule)).toEqual(rule);
  });

  it('checks route scope against route templates', () => {
    const scoped = { ...BUILTIN_RULES[0]!, routes: ['/product/:id'] };
    expect(checkRule(scoped, buggy, '/product/123').applicable).toBe(true);
    expect(checkRule(scoped, buggy, '/cart').applicable).toBe(false);
  });
});
