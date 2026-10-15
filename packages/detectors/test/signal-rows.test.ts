import { describe, expect, it } from 'vitest';
import type { Signal } from '@cp/schema';
import { invariantCheck, signalId, toSignalRows } from '../src/index.js';

const signal: Signal = {
  detector: 'invariant_check',
  fingerprint: 'fp',
  eventTime: 1_790_000_001_040,
  ruleVersion: 'cart_total_matches_lines@1',
  evidence: { sessionId: 's_rows_test_1', seq: 2, tStart: 1_790_000_001_040, tEnd: 1_790_000_001_040, route: '/cart?x=1', values: { rule_id: 'cart_total_matches_lines' } },
};
const run = { detector: invariantCheck, ruleVersion: 'pdeadbeef', signals: [signal] };

describe('toSignalRows', () => {
  it('keeps the signal id formula stable (live rows, re-scans, and stored data must agree)', () => {
    // Pinned: changing the formula would make a re-scan duplicate every hit the live pipeline already wrote.
    expect(signalId('demo', run, signal)).toBe(PINNED_ID);
  });

  it('builds the same row live and in a re-scan, apart from the re-scan id and ingest time', () => {
    const live = toSignalRows([run], { tenantId: 'demo', sessionId: 's_rows_test_1', pageRoute: '/cart', release: 'r1', ingestTime: 10 });
    const rescan = toSignalRows([run], { tenantId: 'demo', sessionId: 's_rows_test_1', pageRoute: '/cart', release: 'r1', ingestTime: 99, rescanId: 'rs_1' });
    expect(live[0]).toMatchObject({ signal_id: PINNED_ID, rule_version: 'cart_total_matches_lines@1', detector_version: invariantCheck.version, route: '/cart', event_time: signal.eventTime, ingest_time: 10 });
    expect(live[0]).not.toHaveProperty('rescan_id');
    expect(rescan[0]).toMatchObject({ signal_id: PINNED_ID, event_time: signal.eventTime, ingest_time: 99, rescan_id: 'rs_1' });
  });
});

const PINNED_ID = '0e4bcfca8d5e53003901e1d86b32749a';
