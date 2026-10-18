import type { HistoryFindingView, HistoryMomentView } from '../api';

/** Total revenue at risk of the findings with an estimate, in the first currency seen. */
export function totalAtRisk(list: readonly HistoryFindingView[]): { minor: number; currency: string | null } {
  const ok = list.filter((f) => f.revenue_status === 'ok' && f.currency);
  const currency = ok[0]?.currency ?? null;
  return { minor: ok.filter((f) => f.currency === currency).reduce((n, f) => n + f.revenue_at_risk_minor, 0), currency };
}

/** Where the slider starts: just before the latest rule approval (the moment a re-scan changes the answer), else now. */
export function defaultAsOf(moments: readonly HistoryMomentView[], now: number): number {
  const approvals = moments.filter((m) => m.kind === 'rule_approved');
  return approvals.length ? approvals[approvals.length - 1]!.at - 1000 : now;
}
