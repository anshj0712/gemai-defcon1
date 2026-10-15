import { BUILTIN_RULES } from '@cp/detectors';
import type { Logger } from '@cp/logger';
import type { StateStore } from '@cp/platform';
import { InvariantRuleSchema, type InvariantRule } from '@cp/schema';

export interface RuleSourceDeps {
  state: Pick<StateStore, 'listRules'>;
  /** tenant -> base rules from INVARIANT_RULES; tenants not listed get the built-in rules. */
  base: Record<string, InvariantRule[]>;
  /** How long a tenant's rule list is reused before the state store is read again. */
  ttlMs: number;
  logger: Logger;
  now?: () => number;
}

/**
 * A tenant's active invariant rules: the base set plus every approved tenant rule (Phase 4; the
 * approved version from the rule's hot doc). An approved rule replaces a base rule with the same id.
 * Cached per tenant for `ttlMs`, so an approval reaches live traffic within that time. When the store
 * cannot be read, the last good list (or the base set) is used rather than failing the chunk.
 */
export function createRuleSource(deps: RuleSourceDeps): (tenantId: string) => Promise<InvariantRule[]> {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { rules: InvariantRule[]; at: number }>();
  const inflight = new Map<string, Promise<InvariantRule[]>>();

  async function load(tenantId: string): Promise<InvariantRule[]> {
    const base = deps.base[tenantId] ?? BUILTIN_RULES;
    try {
      const approved: InvariantRule[] = [];
      for (const doc of await deps.state.listRules(tenantId)) {
        if (!doc.active) continue;
        const parsed = InvariantRuleSchema.safeParse(doc.active.rule);
        if (parsed.success) approved.push(parsed.data);
        else deps.logger.warn({ tenant_id: tenantId, rule_id: doc.rule_id }, 'approved rule failed validation; skipped');
      }
      const ids = new Set(approved.map((r) => r.id));
      const rules = [...base.filter((r) => !ids.has(r.id)), ...approved];
      cache.set(tenantId, { rules, at: now() });
      return rules;
    } catch (err) {
      deps.logger.warn({ err, tenant_id: tenantId }, 'could not read tenant rules; using the last known set');
      return cache.get(tenantId)?.rules ?? base;
    }
  }

  return (tenantId) => {
    const hit = cache.get(tenantId);
    if (hit && now() - hit.at < deps.ttlMs) return Promise.resolve(hit.rules);
    let pending = inflight.get(tenantId);
    if (!pending) {
      pending = load(tenantId).finally(() => inflight.delete(tenantId));
      inflight.set(tenantId, pending);
    }
    return pending;
  };
}
