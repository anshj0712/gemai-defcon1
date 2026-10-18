import { describe, expect, it } from 'vitest';
import type { ClusterSummary, SignalRowView } from '../src/api';
import { duration } from '../src/format';
import { buildLanes, revenueAt, revenueSeries, trendOf, withCurrent, type SeriesItem } from '../src/lib/series';
import { groupSignals } from '../src/lib/signals';

/** Dashboard charts and grouping. All numbers are synthetic. */

const item = (id: string, versions: [number, number | null, number][], resolvedAt: number | null = null): SeriesItem => ({
  id,
  title: `Issue ${id}`,
  versions: versions.map(([recorded_from, recorded_to, revenue_at_risk_minor]) => ({ recorded_from, recorded_to, revenue_at_risk_minor })),
  resolvedAt,
});

describe('revenue at risk over time', () => {
  it('reads the version that was current at each moment', () => {
    const a = item('a', [
      [100, 200, 1_000],
      [200, null, 3_000],
    ]);
    expect(revenueAt(a, 50)).toBe(0);
    expect(revenueAt(a, 100)).toBe(1_000);
    expect(revenueAt(a, 199)).toBe(1_000);
    expect(revenueAt(a, 200)).toBe(3_000);
    expect(revenueAt(a, 10_000)).toBe(3_000);
  });

  it('drops a finding to zero once it is marked fixed', () => {
    const a = item('a', [[0, null, 5_000]], 500);
    expect(revenueAt(a, 499)).toBe(5_000);
    expect(revenueAt(a, 500)).toBe(0);
  });

  it('stacks the biggest issues under their own keys and adds the rest up as other', () => {
    const items = [item('a', [[0, null, 100]]), item('b', [[0, null, 300]]), item('c', [[0, null, 200]]), item('d', [[50, null, 50]])];
    const { points, keys } = revenueSeries(items, 0, 100, 4, 2);
    expect(keys).toEqual([
      { key: 'k0', label: 'Issue b', id: 'b' },
      { key: 'k1', label: 'Issue c', id: 'c' },
      { key: 'other', label: '2 other issues', id: null },
    ]);
    expect(points.map((p) => p.t)).toEqual([0, 25, 50, 75, 100]);
    expect(points[0]).toEqual({ t: 0, total: 600, k0: 300, k1: 200, other: 100 });
    expect(points[4]).toEqual({ t: 100, total: 650, k0: 300, k1: 200, other: 150 });
  });

  it('keeps a fixed issue in the legend by its peak, so the drop after the fix shows', () => {
    const { points, keys } = revenueSeries([item('a', [[0, null, 900]], 60), item('b', [[0, null, 100]])], 0, 100, 2, 1);
    expect(keys[0]).toMatchObject({ id: 'a' });
    expect(points.map((p) => p.total)).toEqual([1_000, 1_000, 100]);
  });

  it('continues the history with the live value from its last update', () => {
    const v = [
      { recorded_from: 0, recorded_to: 100, revenue_at_risk_minor: 10 },
      { recorded_from: 100, recorded_to: null, revenue_at_risk_minor: 20 },
    ];
    expect(withCurrent(v, { at: 150, revenue_at_risk_minor: 35 })).toEqual([
      { recorded_from: 0, recorded_to: 100, revenue_at_risk_minor: 10 },
      { recorded_from: 100, recorded_to: 150, revenue_at_risk_minor: 20 },
      { recorded_from: 150, recorded_to: null, revenue_at_risk_minor: 35 },
    ]);
    expect(withCurrent(v, { at: 50, revenue_at_risk_minor: 99 })).toEqual(v);
    expect(withCurrent(v, { at: 150, revenue_at_risk_minor: 20 })).toEqual(v);
    expect(withCurrent([], { at: 5, revenue_at_risk_minor: 7 })).toEqual([{ recorded_from: 5, recorded_to: null, revenue_at_risk_minor: 7 }]);
  });
});

describe('signals grouped by issue', () => {
  const sig = (id: string, fp: string, t: number, detector = 'dead_click'): SignalRowView =>
    ({ signal_id: id, session_id: `s_${id}`, fingerprint: fp, event_time: t, detector }) as unknown as SignalRowView;
  const cluster = (id: string, fingerprints: string[]): ClusterSummary => ({ cluster_id: id, fingerprints }) as unknown as ClusterSummary;

  it('puts each signal under the issue whose fingerprints include it, newest group first, the rest last', () => {
    const groups = groupSignals(
      [sig('1', 'fpA', 10), sig('2', 'fpB', 30), sig('3', 'fpA', 20, 'rage_click'), sig('4', 'fpX', 40), sig('5', 'fpA', 5)],
      [cluster('A', ['fpA']), cluster('B', ['fpB'])],
    );
    expect(groups.map((g) => [g.cluster?.cluster_id ?? null, g.signals.map((s) => s.signal_id), g.lastSeen])).toEqual([
      ['B', ['2'], 30],
      ['A', ['3', '1', '5'], 20],
      [null, ['4'], 40],
    ]);
    expect(groups[1]!.detectors).toEqual([
      ['dead_click', 2],
      ['rage_click', 1],
    ]);
  });
});

describe('trend and detection lanes', () => {
  const issue = (versions: [number, number | null, number][]) => item('t', versions);

  it('calls an issue worse, better or steady against a moment ago', () => {
    const rising = issue([
      [0, 500, 1_000],
      [500, null, 4_000],
    ]);
    expect(trendOf(rising, 1_000, 600)).toEqual({ now: 4_000, before: 1_000, direction: 'up' });
    const fixed = item('f', [[0, null, 5_000]], 800);
    expect(trendOf(fixed, 1_000, 400).direction).toBe('down');
    expect(trendOf(issue([[0, null, 2_000]]), 1_000, 400).direction).toBe('flat');
  });

  it('counts a brand-new issue as getting worse', () => {
    expect(trendOf(issue([[900, null, 700]]), 1_000, 400).direction).toBe('up');
  });

  it('measures the time shoppers were hurt before the record knew, never negative, biggest money first', () => {
    const lanes = buildLanes([
      { id: 'a', title: 'A', firstHit: 100, firstKnown: 700, fixedAt: null, revenueMinor: 1_000 },
      { id: 'b', title: 'B', firstHit: 900, firstKnown: 800, fixedAt: 950, revenueMinor: 9_000 },
    ]);
    expect(lanes.map((l) => l.id)).toEqual(['b', 'a']);
    expect(lanes[0]).toMatchObject({ firstHit: 800, blindMs: 0 });
    expect(lanes[1]).toMatchObject({ firstHit: 100, blindMs: 600 });
  });
});

describe('duration in words', () => {
  it('reads naturally', () => {
    expect(duration(40_000)).toBe('40 s');
    expect(duration(12 * 60_000)).toBe('12 min');
    expect(duration(190 * 60_000)).toBe('3 h 10 min');
    expect(duration(2 * 86_400_000)).toBe('2 days');
  });
});
