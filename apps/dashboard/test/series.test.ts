import { describe, expect, it } from 'vitest';
import type { ClusterSummary, SignalRowView } from '../src/api';
import { revenueAt, revenueSeries, type SeriesItem } from '../src/lib/series';
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
