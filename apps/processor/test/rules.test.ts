import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_RULES } from '@cp/detectors';
import { createLogger } from '@cp/logger';
import { LocalStateStore } from '@cp/platform';
import type { InvariantRule, RuleDoc } from '@cp/schema';
import { createRuleSource } from '../src/rules.js';

const quiet = createLogger({ service: 'processor', format: 'json', level: 'silent', toCloud: false });

const capRule: InvariantRule = {
  id: 'bag_price_cap',
  version: 1,
  title: 'Bag costs more than the dearest pair per unit',
  requires: ['line_total', 'qty'],
  assert: { left: { sum: 'line_total' }, op: 'lte', right: { mul: [{ const: 1_700_000 }, { sum: 'qty' }] }, tolerance_minor: 0 },
};

const doc = (rule: InvariantRule | null, over: Partial<RuleDoc> = {}): RuleDoc => ({
  v: 1,
  tenant_id: 'demo',
  rule_id: rule?.id ?? 'pending_rule',
  title: rule?.title ?? 'pending',
  active: rule ? { rule, sentence: 's', author: null, approved_at: 1, approved_by: 'test' } : null,
  draft: null,
  rescan: null,
  versions: [],
  created_at: 1,
  updated_at: 1,
  synthetic: true,
  ...over,
});

describe('rule source', () => {
  it('adds approved tenant rules to the built-ins, ignoring drafts', async () => {
    const state = new LocalStateStore(mkdtempSync(join(tmpdir(), 'cp-rules-')));
    await state.putRule(doc(capRule));
    await state.putRule(doc(null));
    const rules = await createRuleSource({ state, base: {}, ttlMs: 0, logger: quiet })('demo');
    expect(rules.map((r) => r.id)).toEqual([...BUILTIN_RULES.map((r) => r.id), 'bag_price_cap']);
  });

  it('lets an approved rule replace a base rule with the same id', async () => {
    const state = new LocalStateStore(mkdtempSync(join(tmpdir(), 'cp-rules-')));
    const v2 = { ...BUILTIN_RULES[0]!, version: 2 };
    await state.putRule(doc(v2));
    const rules = await createRuleSource({ state, base: {}, ttlMs: 0, logger: quiet })('demo');
    expect(rules).toEqual([v2]);
  });

  it('caches per tenant, and falls back to the last good list when the store fails', async () => {
    let calls = 0;
    let fail = false;
    let t = 0;
    const state = {
      listRules: async () => {
        calls++;
        if (fail) throw new Error('store down');
        return [doc(capRule)];
      },
    };
    const source = createRuleSource({ state, base: { demo: [] }, ttlMs: 1000, logger: quiet, now: () => t });
    expect((await source('demo')).map((r) => r.id)).toEqual(['bag_price_cap']);
    await source('demo');
    expect(calls).toBe(1);
    t = 2000;
    fail = true;
    expect((await source('demo')).map((r) => r.id)).toEqual(['bag_price_cap']);
    expect(calls).toBe(2);
  });
});
