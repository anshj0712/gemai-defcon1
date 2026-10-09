import { describe, expect, it } from 'vitest';
import { parseRoute } from '../src/App';
import { clipWindow, formatOffset, forPlayer, injectMarkers, isFlagEvent, tagColors, type Marker } from '../src/markers';

const marker = (replay_ts: number, detector = 'dead_click'): Marker => ({
  signal_id: `sig-${replay_ts}`,
  detector,
  label: `${detector} at ${replay_ts}`,
  replay_ts,
  event_time: replay_ts + 250,
  seq: 0,
  selector: 'button#apply-coupon',
  node_id: 9,
  fingerprint: 'fp',
});

describe('injectMarkers', () => {
  const events = [
    { type: 4, timestamp: 1000 },
    { type: 2, timestamp: 1005 },
    { type: 3, timestamp: 2000 },
    { type: 3, timestamp: 3000 },
  ];

  it('inserts flags in time order, after recorded events with the same timestamp', () => {
    const out = injectMarkers(events, [marker(3000), marker(1500)]);
    expect(out.map((e) => [e.type, e.timestamp])).toEqual([
      [4, 1000],
      [2, 1005],
      [5, 1500],
      [3, 2000],
      [3, 3000],
      [5, 3000],
    ]);
    expect(out.filter(isFlagEvent).map((e) => e.data.tag)).toEqual(['cp.flag.dead_click', 'cp.flag.dead_click']);
  });

  it('keeps flags after the last event and leaves inputs untouched', () => {
    const input = [...events];
    const out = injectMarkers(input, [marker(9000)]);
    expect(out.at(-1)).toMatchObject({ type: 5, timestamp: 9000, data: { payload: { node_id: 9, selector: 'button#apply-coupon' } } });
    expect(input).toEqual(events);
  });

  it('colors each detector on the timeline', () => {
    expect(tagColors([marker(1), marker(2, 'rage_click')])).toEqual({ 'cp.error': '#db2777', 'cp.flag.dead_click': '#ef4444', 'cp.flag.rage_click': '#f97316' });
  });

  it('keeps DOM events, flags, and JS errors for the player; drops network and navigation metadata', () => {
    const recorded = [
      { type: 2, timestamp: 1 },
      { type: 5, timestamp: 2, data: { tag: 'cp.net', payload: {} } },
      { type: 5, timestamp: 3, data: { tag: 'cp.nav', payload: {} } },
      { type: 5, timestamp: 4, data: { tag: 'cp.error', payload: {} } },
      { type: 3, timestamp: 5 },
    ];
    const out = forPlayer(recorded, [marker(5)]);
    expect(out.map((e) => [e.type, e.timestamp])).toEqual([
      [2, 1],
      [5, 4],
      [3, 5],
      [5, 5],
    ]);
  });

  it('does not treat recorded custom events as flags', () => {
    expect(isFlagEvent({ type: 5, timestamp: 1, data: { tag: 'cp.net', payload: {} } })).toBe(false);
  });
});

describe('clipWindow', () => {
  it('takes 6 s before and 3 s after, clamped to the recording', () => {
    expect(clipWindow(20_000, 60_000)).toEqual([14_000, 23_000]);
    expect(clipWindow(2_000, 60_000)).toEqual([0, 5_000]);
    expect(clipWindow(59_000, 60_000)).toEqual([53_000, 60_000]);
  });

  it('formats offsets as m:ss', () => {
    expect(formatOffset(75_400)).toBe('1:15');
  });
});

describe('parseRoute', () => {
  it('reads the session and signal from the hash', () => {
    expect(parseRoute('#/sessions/s_abc123xyz?signal=sig1')).toEqual({ page: 'replay', sessionId: 's_abc123xyz', signalId: 'sig1' });
    expect(parseRoute('#/sessions/s_abc123xyz')).toEqual({ page: 'replay', sessionId: 's_abc123xyz', signalId: null });
  });

  it('routes the issues feed, issue pages, and the signals list', () => {
    expect(parseRoute('#/')).toEqual({ page: 'issues' });
    expect(parseRoute('')).toEqual({ page: 'issues' });
    expect(parseRoute('#/issues/0123456789abcdef0123')).toEqual({ page: 'issue', clusterId: '0123456789abcdef0123' });
    expect(parseRoute('#/signals')).toEqual({ page: 'signals' });
    expect(parseRoute('#/sessions/../../x')).toEqual({ page: 'issues' });
    expect(parseRoute('#/issues/not-an-id')).toEqual({ page: 'issues' });
  });
});

describe('findings in the dashboard', async () => {
  const { rankIssues } = await import('../src/IssuesPage');
  const { formulaLine, money } = await import('../src/format');

  it('puts scored issues first in finding order, then unscored ones', () => {
    const c = (id: string) => ({ cluster_id: id, title: id }) as never;
    const f = (id: string) => ({ cluster_id: id, finding_id: id }) as never;
    expect(rankIssues([c('a'), c('b'), c('c')], [f('c'), f('a'), f('gone')]).map((x) => [x.cluster.cluster_id as string, x.finding !== null])).toEqual([
      ['c', true],
      ['a', true],
      ['b', false],
    ]);
  });

  it('spells out revenue at risk with its numbers (synthetic)', () => {
    expect(money(3_500_000, 'INR')).toBe('₹35,000');
    expect(formulaLine({ affected_with_cart: 10, avg_cart_value_minor: 1_000_000, abandonment_affected: 0.6, abandonment_baseline: 0.25, revenue_at_risk_minor: 3_500_000, currency: 'INR' })).toBe(
      '10 sessions × ₹10,000 × (60% − 25%) = ₹35,000',
    );
  });
});
