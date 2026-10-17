import { FLAG_COLORS } from './markers';

/** Plain-language names for detectors, shown as symptom chips. */
export const SYMPTOMS: Record<string, string> = {
  dead_click: 'Dead clicks',
  rage_click: 'Rage clicks',
  response_decay: 'Stopped responding',
  invariant_check: 'Wrong totals',
  error_correlation: 'Errors',
};

export const symptomName = (detector: string) => SYMPTOMS[detector] ?? detector.replace(/_/g, ' ');
export const symptomColor = (detector: string) => FLAG_COLORS[detector] ?? '#6b7280';

/** "just now", "42 s ago", "5 min ago", "3 h ago", or a date. */
export function ago(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Money in minor units, for example ₹35,000. Whole units unless the amount is small. */
export function money(minor: number | null | undefined, currency: string | null | undefined): string {
  if (typeof minor !== 'number') return '-';
  const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined;
  const digits = Math.abs(minor) < 100_00 ? 2 : 0;
  return code
    ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: code, maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(minor / 100)
    : (minor / 100).toLocaleString('en-IN', { maximumFractionDigits: digits });
}

export const pct = (x: number | null | undefined) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : '-');

export const TIER_COLORS: Record<string, string> = { P0: '#dc2626', P1: '#ea580c', P2: '#ca8a04', P3: '#64748b' };
export const TIER_NAMES: Record<string, string> = { P0: 'P0 · blocker', P1: 'P1 · pricing', P2: 'P2 · friction', P3: 'P3 · minor' };
export const tierColor = (t: string) => TIER_COLORS[t] ?? '#64748b';

export const CATEGORY_NAMES: Record<string, string> = {
  checkout_blocker: 'Checkout blocker',
  pricing_error: 'Pricing error',
  broken_control: 'Broken control',
  error_spike: 'Error spike',
  other: 'Other',
};

/** The revenue-at-risk formula with this finding's numbers, as one line of text. */
export function formulaLine(r: {
  affected_with_cart: number;
  avg_cart_value_minor: number | null;
  abandonment_affected: number | null;
  abandonment_baseline: number | null;
  revenue_at_risk_minor: number;
  currency: string | null;
}): string {
  const n = Number.isInteger(r.affected_with_cart) ? String(r.affected_with_cart) : r.affected_with_cart.toFixed(1);
  return `${n} sessions × ${money(r.avg_cart_value_minor, r.currency)} × (${pct(r.abandonment_affected)} − ${pct(r.abandonment_baseline)}) = ${money(r.revenue_at_risk_minor, r.currency)}`;
}

/** Gemini cites evidence inline as "(E1, E11)"; the clickable chips already show those, so the sentence reads cleaner without them. */
export const plain = (text: string) =>
  text
    .replace(/\s*\(\s*E\d+(?:\s*,\s*E\d+)*\s*\)/g, '')
    .replace(/\s+([.,;])/g, '$1')
    .trim();

/** Marked fixed, and not seen again since. An issue seen after it was marked is open again. */
export const isResolved = (f: { resolution?: { resolved_at: number } | undefined; last_seen: number } | null | undefined): boolean => !!f?.resolution && f.last_seen <= f.resolution.resolved_at;

/** Money for chart axes and tight labels: ₹10.9L, ₹96K (Indian compact units for INR). */
export function moneyCompact(minor: number | null | undefined, currency: string | null | undefined): string {
  if (typeof minor !== 'number') return '-';
  const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined;
  const opts: Intl.NumberFormatOptions = code ? { style: 'currency', currency: code, notation: 'compact', maximumFractionDigits: 1 } : { notation: 'compact', maximumFractionDigits: 1 };
  return new Intl.NumberFormat('en-IN', opts).format(minor / 100);
}
