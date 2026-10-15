import type { RuleAuthorOutput, RuleTerm } from '@cp/schema';

/**
 * The offline stand-in's rule author: a small deterministic parser for three sentence families, so the
 * local demo runs without a key. It is not a language model. Anything else comes back as not
 * understood, with a pointer to GOOGLE_API_KEY. Drafts it writes record the offline model id.
 *
 *   per-unit cap   "... the bag subtotal must never be more than ₹17,000 times the number of pairs"
 *   discount cap   "the discount must never be more than 10% of the bag"
 *   totals match   "the cart total must equal the line items minus the discount"
 */

interface Item {
  id: string;
  kind: string;
  text?: string;
  name?: string;
}

const term = (over: Partial<RuleTerm> & Pick<RuleTerm, 'kind'>): RuleTerm => ({ coef: 1, probe: '', index: 0, value: 0, default_zero: false, ...over });

function notUnderstood(text: string, cite: string[]): RuleAuthorOutput {
  return {
    understood: false,
    rule_id: '',
    title: '',
    left: [],
    op: 'eq',
    right: [],
    tolerance_minor: 0,
    routes: [],
    highlight_probe: '',
    explanation: { text, evidence_ids: cite },
    assumptions: [],
  };
}

/** "₹17,000", "Rs 17000", "17,000.50" -> minor units (two decimals). */
function moneyMinor(s: string): { minor: number; text: string } | null {
  // Thousands separators only between digits, so the comma in "₹17,000, so ..." stays out.
  const m = /(?:₹|rs\.?\s*|inr\s*)?\s*(\d+(?:,\d+)*(?:\.\d+)?)/i.exec(s);
  if (!m?.[1]) return null;
  const major = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(major) && major > 0 ? { minor: Math.round(major * 100), text: m[0].trim() } : null;
}

export function offlineRuleAuthor(payload: { evidence?: Item[] }): RuleAuthorOutput {
  const items = payload.evidence ?? [];
  const sentence = items.find((i) => i.kind === 'sentence');
  const sid = sentence?.id ?? 'S1';
  const text = (sentence?.text ?? '').toLowerCase();
  const probes = new Map(items.filter((i) => i.kind === 'probe' && i.name).map((i) => [i.name!, i.id]));
  const need = (...names: string[]) => names.every((n) => probes.has(n));
  const cite = (...names: string[]) => [sid, ...names.map((n) => probes.get(n)!)];
  const fallback = 'The offline stand-in only understands the example sentences (a per-pair price cap, a discount cap, or totals that add up). Set GOOGLE_API_KEY to draft any rule with Gemini.';

  // 1. Per-unit cap: subtotal <= amount x number of pairs.
  const perUnit = /more than\s+(.+?)\s+(?:times|x|×|per)\s+(?:the\s+)?(?:number of\s+)?(pairs?|items?|units?|shoes?)/.exec(text);
  if (perUnit && /(subtotal|bag|cart|total)/.test(text)) {
    const amount = moneyMinor(perUnit[1]!);
    if (!amount) return notUnderstood(fallback, [sid]);
    if (!need('line_total', 'qty')) return notUnderstood('This needs a per-line total probe (line_total) and a quantity probe (qty), and the store does not report both.', [sid]);
    return {
      understood: true,
      rule_id: 'bag_subtotal_per_pair_cap',
      title: `Bag subtotal is more than ${amount.text} a pair`,
      left: [term({ kind: 'sum', probe: 'line_total' })],
      op: 'lte',
      right: [term({ kind: 'sum', probe: 'qty', coef: amount.minor })],
      tolerance_minor: 0,
      routes: [],
      highlight_probe: 'line_total',
      explanation: { text: `The bag subtotal is the sum of the line totals (line_total); the number of pairs is the sum of the line quantities (qty). The rule caps the subtotal at ${amount.text} (${amount.minor} minor units) per pair.`, evidence_ids: cite('line_total', 'qty') },
      assumptions: ['Money has two decimal places (minor units = amount x 100).', 'Each unit of qty is one pair.'],
    };
  }

  // 2. Discount cap: discount <= pct% of the subtotal.
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(text);
  if (pct && /discount/.test(text) && /(more than|exceed|above|over|at most|no more|up to)/.test(text)) {
    if (!need('discount', 'line_total')) return notUnderstood('This needs a discount probe and a per-line total probe (line_total).', [sid]);
    const p = Number(pct[1]);
    return {
      understood: true,
      rule_id: `discount_at_most_${String(p).replace('.', '_')}_pct`,
      title: `Discount is more than ${p}% of the bag`,
      left: [term({ kind: 'probe', probe: 'discount', default_zero: true })],
      op: 'lte',
      right: [term({ kind: 'sum', probe: 'line_total', coef: p / 100 })],
      tolerance_minor: 1,
      routes: [],
      highlight_probe: 'discount',
      explanation: { text: `The discount probe must stay at or below ${p}% of the bag subtotal (the sum of line_total), with 1 minor unit of slack for rounding.`, evidence_ids: cite('discount', 'line_total') },
      assumptions: ['The subtotal is the sum of the line totals before the discount.'],
    };
  }

  // 3. Totals match: cart_total = sum(line_total) - discount.
  if (/total/.test(text) && /(equal|match|add up|=)/.test(text) && /(line|item)/.test(text)) {
    if (!need('cart_total', 'line_total')) return notUnderstood('This needs a cart total probe (cart_total) and a per-line total probe (line_total).', [sid]);
    const withDiscount = /discount/.test(text) && probes.has('discount');
    return {
      understood: true,
      rule_id: 'cart_total_equals_lines',
      title: "Cart total doesn't add up to its lines",
      left: [term({ kind: 'probe', probe: 'cart_total' })],
      op: 'eq',
      right: [term({ kind: 'sum', probe: 'line_total' }), ...(withDiscount ? [term({ kind: 'probe', probe: 'discount', coef: -1, default_zero: true })] : [])],
      tolerance_minor: 1,
      routes: [],
      highlight_probe: 'cart_total',
      explanation: { text: `The cart total must equal the sum of the line totals${withDiscount ? ' minus the discount' : ''}, within 1 minor unit for rounding.`, evidence_ids: withDiscount ? cite('cart_total', 'line_total', 'discount') : cite('cart_total', 'line_total') },
      assumptions: withDiscount ? ['A missing discount means no discount.'] : [],
    };
  }

  return notUnderstood(fallback, [sid]);
}
