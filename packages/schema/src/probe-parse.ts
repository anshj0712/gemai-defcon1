/**
 * Turning a probe element's text into a number. Shared by the browser SDK (declared probes, parsed before
 * anything leaves the page) and the normalizer (recorded probes, read from the already-masked recording),
 * so both read "₹1,299" the same way. Browser-safe: no Node imports.
 */

/**
 * "₹17,181" -> 1718100, "₹1,079.5" -> 107950, "$12.99" -> 1299. Thousands separators are commas,
 * the decimal separator a point (set `decimal: ','` for "1.234,56"). Null when there is no number.
 */
export function parseMoney(text: string, opts: { fractionDigits?: number; decimal?: '.' | ',' } = {}): number | null {
  const digits = opts.fractionDigits ?? 2;
  const decimal = opts.decimal ?? '.';
  const m = /-?\d[\d.,\s]*/.exec(text.replace(/ /g, ' '));
  if (!m) return null;
  const raw = m[0].replace(/\s/g, '');
  const negative = raw.startsWith('-');
  const thousands = decimal === '.' ? ',' : '.';
  const cleaned = raw.replace('-', '').split(thousands).join('');
  const [whole = '0', frac = ''] = cleaned.split(decimal);
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac)) return null;
  const minor = Number(whole) * 10 ** digits + Math.round(Number(`0.${frac || '0'}`) * 10 ** digits);
  return negative ? -minor : minor;
}

/** "Qty 3" -> 3, "Arrives in 9–12 days" -> 9 (the first whole number). */
export function parseCount(text: string): number | null {
  const m = /-?\d+/.exec(text);
  return m ? Number(m[0]) : null;
}

/** money: minor units (default); count: the first whole number. */
export type ProbeValueKind = 'money' | 'count';

export function parseProbeValue(text: string, kind: ProbeValueKind | undefined): number | null {
  const v = kind === 'count' ? parseCount(text) : parseMoney(text);
  return v !== null && Number.isFinite(v) ? v : null;
}
