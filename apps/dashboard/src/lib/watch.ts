import type { ChurnReason, WatchMeta } from '@cp/schema';
import { money } from '../format';

/** Churn reason labels (the schema's CHURN_REASONS; typed against it so the two cannot drift). */
export const CHURN_REASONS: Record<ChurnReason, string> = {
  ux: 'Poor user experience',
  shipping_cost: 'Shipping cost',
  delivery_time: 'Delivery time',
  returns: 'Returns hassle',
  price: 'Price',
  support: 'Customer service',
  personalization: 'Personalization',
  discount: 'Discounts and promotions',
  payment_declined: 'Declined card',
  payment_gateway: 'Payment gateway',
  other: 'Other',
};

/** One line on what a watch pass looked at and what it raised. */
export function watchSummary(r: { results: unknown }): string {
  const x = r.results as { sessions?: number; decided?: number; numbers?: number; candidates?: { outcome: string }[] } | null;
  if (!x || typeof x !== 'object') return 'The agent looked at the latest sessions.';
  const drafted = (x.candidates ?? []).filter((c) => c.outcome === 'drafted').length;
  const declined = (x.candidates ?? []).length - drafted;
  return `Looked at ${x.sessions ?? 0} sessions (${x.decided ?? 0} with a settled cart) and ${x.numbers ?? 0} numbers: ${drafted ? `${drafted} new hypothes${drafted === 1 ? 'is' : 'es'}` : 'nothing new'}${declined ? `, ${declined} judged not worth a rule` : ''}.`;
}

/** "very unlikely to be chance (p < 0.001)": a p-value said plainly. */
export function chanceText(p: number): string {
  if (p < 0.001) return 'very unlikely to be chance (p < 0.001)';
  if (p < 0.01) return `unlikely to be chance (p = ${p.toFixed(3)})`;
  return `p = ${p.toFixed(2)}`;
}

/** A value of the number a hypothesis is about, in its unit. */
export function watchValue(unit: WatchMeta['feature']['unit'], v: number | null): string {
  if (v === null) return 'none';
  if (unit === 'money') return money(v, 'INR');
  if (unit === 'ms') return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
  return v.toLocaleString('en-IN');
}
