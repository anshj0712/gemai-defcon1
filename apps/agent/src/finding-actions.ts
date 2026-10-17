import type { StateStore } from '@cp/platform';
import type { Finding } from '@cp/schema';

/**
 * What a person can do to a finding on the hot copy: mark the issue fixed, or reopen it. A finding counts as
 * resolved only while it has not been seen again after it was marked (see `isResolved`), so a fix that did not
 * hold reopens by itself. These touch the hot copy only; every analysis version stays in the findings table.
 */
export interface FindingActions {
  resolve(tenantId: string, findingId: string, by: string): Promise<Finding | null>;
  reopen(tenantId: string, findingId: string): Promise<Finding | null>;
}

export const isResolved = (f: Pick<Finding, 'resolution' | 'last_seen'>): boolean => !!f.resolution && f.last_seen <= f.resolution.resolved_at;

export function createFindingActions(state: Pick<StateStore, 'getFinding' | 'putFinding'>, now: () => number = Date.now): FindingActions {
  return {
    async resolve(tenantId, findingId, by) {
      const f = await state.getFinding(tenantId, findingId);
      if (!f) return null;
      const next: Finding = { ...f, resolution: { resolved_at: now(), resolved_by: by } };
      await state.putFinding(next);
      return next;
    },
    async reopen(tenantId, findingId) {
      const f = await state.getFinding(tenantId, findingId);
      if (!f) return null;
      const { resolution: _gone, ...rest } = f;
      await state.putFinding(rest);
      return rest;
    },
  };
}
