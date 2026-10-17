import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalStateStore } from '@cp/platform';
import type { Finding } from '@cp/schema';
import { createFindingActions, isResolved } from '../src/finding-actions.js';

describe('marking an issue fixed', () => {
  const f = { tenant_id: 'demo', finding_id: 'f1', last_seen: 1000 } as Finding;

  it('is resolved only until the issue is seen again', () => {
    expect(isResolved({ ...f, resolution: { resolved_at: 1000, resolved_by: 'x' } })).toBe(true);
    expect(isResolved({ ...f, last_seen: 1001, resolution: { resolved_at: 1000, resolved_by: 'x' } })).toBe(false);
    expect(isResolved(f)).toBe(false);
  });

  it('resolves and reopens on the hot copy, and answers null for an unknown finding', async () => {
    const state = new LocalStateStore(join(mkdtempSync(join(tmpdir(), 'cp-fa-')), 'fs'));
    await state.putFinding(f);
    const actions = createFindingActions(state, () => 5000);
    expect(await actions.resolve('demo', 'f1', 'dashboard')).toMatchObject({ resolution: { resolved_at: 5000, resolved_by: 'dashboard' } });
    expect((await state.getFinding('demo', 'f1'))?.resolution?.resolved_at).toBe(5000);
    expect((await actions.reopen('demo', 'f1'))?.resolution).toBeUndefined();
    expect(await actions.resolve('demo', 'nope', 'x')).toBeNull();
  });
});
