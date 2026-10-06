import { describe, expect, it } from 'vitest';
import { deadClick, effectiveParams, fingerprint, normalizeSelector, routeTemplate, ruleVersion, runDetectors, stableStringify } from '../src/index.js';
import type { Detector } from '@cp/schema';

describe('normalizeSelector', () => {
  it.each([
    ['button#apply-coupon', 'button#apply-coupon'],
    ['button#ember1234.btn', 'button.btn'],
    ['div#react-aria-5.menu', 'div.menu'],
    ['button#checkout-3f9a2c1b', 'button'],
    ['button.btn.css-1x2y3z.sc-bdVaJa', 'button.btn'],
    ['button.btn.is-loading.active', 'button.btn'],
    ['a.help:nth-child(3)', 'a.help'],
    ['input[name="coupon"][type="text"]', 'input[name="coupon"][type="text"]'],
    ['form#coupon-form > button.btn-primary', 'form#coupon-form > button.btn-primary'],
    ['div.col-md-6 button.mt-4', 'div.col-md-6 button.mt-4'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeSelector(input)).toBe(expected);
  });
});

describe('routeTemplate', () => {
  it.each([
    ['/product/123', '/product/:id'],
    ['/order/3f9a2c1b-1a2b-4c3d-8e9f-0123456789ab/track', '/order/:id/track'],
    ['/cart?coupon=SAVE10#top', '/cart'],
    ['/product/:id', '/product/:id'],
    ['/', '/'],
    ['/c/shoes/p/aB3dE5fG7hJ9kL1mN', '/c/shoes/p/:id'],
  ])('%s -> %s', (input, expected) => {
    expect(routeTemplate(input)).toBe(expected);
  });
});

describe('fingerprint', () => {
  it('is the same for one control across sessions with different generated ids', () => {
    const a = fingerprint({ detector: 'dead_click', route: '/product/1', selector: 'button#ember101.btn.css-abc12' });
    const b = fingerprint({ detector: 'dead_click', route: '/product/2', selector: 'button#ember999.btn.css-zz9x8' });
    expect(a).toBe(b);
  });

  it('differs by detector, route, and selector', () => {
    const base = { detector: 'dead_click', route: '/cart', selector: 'button#apply-coupon' };
    const fp = fingerprint(base);
    expect(fingerprint({ ...base, detector: 'rage_click' })).not.toBe(fp);
    expect(fingerprint({ ...base, route: '/checkout' })).not.toBe(fp);
    expect(fingerprint({ ...base, selector: 'button#checkout' })).not.toBe(fp);
  });
});

describe('registry', () => {
  it('merges tenant overrides of known params with matching types only', () => {
    expect(effectiveParams(deadClick, { windowMs: 1000, unknown: 5 })).toEqual({ windowMs: 1000 });
    expect(effectiveParams(deadClick, { windowMs: 'fast' })).toEqual({ windowMs: 800 });
  });

  it('versions rules by their effective params', () => {
    expect(ruleVersion({ windowMs: 800 })).toBe(ruleVersion({ windowMs: 800 }));
    expect(ruleVersion({ windowMs: 800 })).not.toBe(ruleVersion({ windowMs: 1000 }));
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it('isolates a detector that throws', () => {
    const broken: Detector = { id: 'broken', version: '0', params: {}, run: () => { throw new Error('boom'); } };
    const ctx = { tenantId: 't', sessionId: 's_registry_test', release: 'r', route: '/', tail: [], prevHorizon: null };
    const chunk = { sessionId: 's_registry_test', seq: 0, route: '/', tStart: 0, tEnd: 1000, events: [] };
    const [bad, good] = runDetectors([broken, deadClick], ctx, chunk);
    expect(bad?.error?.message).toBe('boom');
    expect(good?.error).toBeUndefined();
  });
});
