import { money } from '../format';

/** How a probe's numbers read: milliseconds and statuses for requests, rupees for money-like names, else plain. */
export function probeValue(name: string, v: number, kind?: 'money' | 'count'): string {
  if (name.endsWith('_ms')) return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
  if (name.endsWith('_status')) return String(v);
  if (kind === 'money' || (kind === undefined && /(total|price|fee|discount|amount|subtotal)/.test(name))) return money(v, 'INR');
  return v.toLocaleString('en-IN');
}
