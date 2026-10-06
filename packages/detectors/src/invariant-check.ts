import type { DetectorOutput, Detector, Signal } from '@cp/schema';
import { fingerprint, stableStringify } from './fingerprint.js';
import { BUILTIN_RULES, checkRule } from './rules.js';

export interface InvariantState {
  /** rule id -> the violating snapshot already reported, so one bad state yields one signal. */
  reported: Record<string, string>;
}

/**
 * invariant_check: a probe snapshot violates an active rule (for example the cart total differs from
 * the sum of its line items by more than one minor unit). These are silent data bugs: the shopper
 * gets no error and often no frustration signal at all.
 *
 * Each snapshot is judged once, in the chunk it arrives in. A violation is reported once per distinct
 * violating state; if the state becomes valid and breaks again, it is reported again. The signal's
 * rule version is the rule's own (`rule_id@version`), so re-scans can tell rule versions apart.
 */
export const invariantCheck: Detector = {
  id: 'invariant_check',
  version: '1.0.0',
  params: {},

  run(ctx, chunk): DetectorOutput {
    const rules = ctx.rules ?? BUILTIN_RULES;
    const reported: Record<string, string> = { ...((ctx.state as InvariantState | undefined)?.reported ?? {}) };
    const signals: Signal[] = [];

    for (const e of chunk.events) {
      if (e.kind !== 'probe') continue;
      for (const rule of rules) {
        const check = checkRule(rule, e.values, e.route);
        if (!check.applicable) continue;
        if (check.ok) {
          delete reported[rule.id];
          continue;
        }
        const probes = Object.fromEntries([...rule.requires, rule.highlight_probe].filter((p): p is string => !!p && !!e.values[p]).map((p) => [p, e.values[p]]));
        const stateKey = stableStringify(probes);
        if (reported[rule.id] === stateKey) continue;
        reported[rule.id] = stateKey;
        const route = e.route ?? chunk.route;
        signals.push({
          detector: 'invariant_check',
          fingerprint: fingerprint({ detector: 'invariant_check', route, errorSignature: `rule:${rule.id}` }),
          eventTime: e.t,
          ruleVersion: `${rule.id}@${rule.version}`,
          evidence: {
            sessionId: chunk.sessionId,
            seq: e.seq,
            tStart: e.t,
            tEnd: e.t,
            route,
            values: {
              rule_id: rule.id,
              rule_version: rule.version,
              rule_title: rule.title,
              op: rule.assert.op,
              expected: check.right,
              actual: check.left,
              delta: check.delta,
              tolerance_minor: rule.assert.tolerance_minor ?? 0,
              currency: e.currency,
              highlight_probe: rule.highlight_probe ?? null,
              probes,
            },
          },
        });
      }
    }
    return { signals, state: { reported } satisfies InvariantState };
  },
};
