import type { RuleAuthorOutput, RuleSuggesterOutput, RuleTerm } from '@cp/schema';

/**
 * The offline stand-in's rule author: a small deterministic parser for four sentence families, so the
 * local demo runs without a key. It is not a language model. Anything else comes back as not
 * understood, with a pointer to GOOGLE_API_KEY. Drafts it writes record the offline model id.
 *
 *   per-unit cap   "... the bag subtotal must never be more than ₹17,000 times the number of pairs"
 *   discount cap   "the discount must never be more than 10% of the bag"
 *   totals match   "the cart total must equal the line items minus the discount"
 *   pairs per line "every line in the bag must hold at least one pair, so the number of pairs must never
 *                   be less than the number of lines in the bag" (what the offline rule suggester proposes)
 *
 * The offline rule suggester (below) is a template too: it proposes that last sentence for a bag line
 * left at quantity 0, and declines everything else with a grounded reason.
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
  const fallback =
    'The offline stand-in only understands the example sentences (a per-pair price cap, a discount cap, totals that add up, at least one pair per bag line) and "<probe name> must never be more than <limit>". Set GOOGLE_API_KEY to draft any rule with Gemini.';

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

  // 4. At least one pair per line: sum(qty) >= count(qty). Checked last so it never takes an example above.
  const perLine =
    (/at least (?:one|1|a single)\b/.test(text) && /\b(?:pairs?|items?|units?|shoes?)\b/.test(text) && /\blines?\b/.test(text)) ||
    /number of (?:pairs|items|units|shoes)\b.*\b(?:less|fewer) than\b.*\bnumber of (?:bag )?lines\b/.test(text);
  if (perLine) {
    if (!need('qty')) return notUnderstood('This needs a quantity probe (qty) with one value per bag line, and the store does not report one.', [sid]);
    return {
      understood: true,
      rule_id: 'bag_lines_have_pairs',
      title: 'A bag line holds no pairs but stays in the bag',
      left: [term({ kind: 'sum', probe: 'qty' })],
      op: 'gte',
      right: [term({ kind: 'count', probe: 'qty' })],
      tolerance_minor: 0,
      routes: [],
      highlight_probe: 'qty',
      explanation: {
        text: 'Each bag line reports its quantity in qty. If every line holds at least one pair, the number of pairs (the sum of qty) is never less than the number of lines (how many qty values there are).',
        evidence_ids: cite('qty'),
      },
      assumptions: ['qty carries one value per bag line.', 'Each unit of qty is one pair.'],
    };
  }

  // 5. One probe, one limit: "<probe> must never be more than <n>" (or "at least <n>"). The probe is named as it
  // appears in the catalog (shipping_fee, req_post_api_payment_authorize_ms); this is the form the offline churn
  // watcher writes, and a merchant can write it too.
  const single = singleProbeLimit(text, [...probes.keys()]);
  if (single) {
    const { probe, op, value, unit } = single;
    const shown = unit === 'money' ? `₹${(value / 100).toLocaleString('en-IN')}` : unit === 'ms' ? `${(value / 1000).toLocaleString('en-IN')} s` : value.toLocaleString('en-IN');
    const base = probe.length > 40 ? probe.slice(0, 40).replace(/_+$/, '') : probe;
    return {
      understood: true,
      rule_id: `${base}_${op === 'lte' ? 'at_most' : 'at_least'}_${value}`.slice(0, 63).replace(/_+$/, ''),
      title: (unit === 'ms' ? `${probe.replace(/^req_/, '').replace(/_ms$/, '').replace(/_/g, ' ')} takes longer than ${shown}` : `${probe.replace(/_/g, ' ')} is ${op === 'lte' ? 'above' : 'below'} ${shown}`).slice(0, 90),
      left: [term({ kind: 'probe', probe })],
      op,
      right: [term({ kind: 'const', value })],
      tolerance_minor: 0,
      routes: [],
      highlight_probe: probe,
      explanation: { text: `The sentence names the probe ${probe} directly and limits it to ${op === 'lte' ? 'at most' : 'at least'} ${shown} (${value}${unit === 'money' ? ' minor units' : unit === 'ms' ? ' ms' : ''}).`, evidence_ids: cite(probe) },
      assumptions: unit === 'money' ? ['Money has two decimal places (minor units = amount x 100).'] : unit === 'ms' ? ['Request probes measure milliseconds.'] : [],
    };
  }

  return notUnderstood(fallback, [sid]);
}

/** The probe a sentence names (the longest catalog name it contains as a word), with its limit. */
export function singleProbeLimit(text: string, names: readonly string[]): { probe: string; op: 'lte' | 'gte'; value: number; unit: 'money' | 'ms' | 'number' } | null {
  const lower = text.toLowerCase();
  const probe = [...names].sort((a, b) => b.length - a.length).find((n) => new RegExp(`(^|[^a-z0-9_])${n}([^a-z0-9_]|$)`).test(lower));
  if (!probe) return null;
  const after = lower.slice(lower.indexOf(probe) + probe.length);
  const lte = /(never be more than|never more than|must not exceed|no more than|at most|within|under|below|not be more than|≤|<=)/.exec(after);
  const gte = /(at least|never be less than|never less than|no less than|≥|>=)/.exec(after);
  const m = lte ?? gte;
  if (!m) return null;
  const rest = after.slice(m.index + m[0].length);
  const op = lte ? 'lte' : 'gte';
  if (/^\s*(?:₹\s*0(?![\d.,])|0\s*(?:rupees|inr)|free|zero)/.test(rest)) return { probe, op, value: 0, unit: 'money' };
  const money = /^\s*(?:₹|rs\.?\s*|inr\s*)\s*(\d+(?:,\d+)*(?:\.\d+)?)/.exec(rest);
  if (money?.[1]) return { probe, op, value: Math.round(Number(money[1].replace(/,/g, '')) * 100), unit: 'money' };
  const num = /^\s*(\d+(?:,\d+)*(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s)?\b/.exec(rest);
  if (!num?.[1]) return null;
  const n = Number(num[1].replace(/,/g, ''));
  const unitWord = num[2] ?? '';
  if (probe.endsWith('_ms')) return { probe, op, value: Math.round(/^s|^sec/.test(unitWord) ? n * 1000 : n), unit: 'ms' };
  return { probe, op, value: n, unit: 'number' };
}

// ---------------------------------------------------------------------------------------------
// The offline rule suggester.
// ---------------------------------------------------------------------------------------------

/** What the offline suggester proposes for a bag line left at quantity 0 (no merchant-only constant). */
export const PAIRS_PER_LINE_SENTENCE = 'Every line in the bag must hold at least one pair, so the number of pairs must never be less than the number of lines in the bag.';

interface SuggestItem {
  id: string;
  kind: string;
  name?: string;
  min?: number;
  data?: Record<string, string | number | boolean | null>;
}

const OFFLINE_NOTE = 'This is the offline stand-in, which only recognises a bag line left at quantity 0; set GOOGLE_API_KEY to let Gemini decide.';

export function offlineRuleSuggester(payload: { evidence?: SuggestItem[] }): RuleSuggesterOutput {
  const items = payload.evidence ?? [];
  const issue = items.find((i) => i.kind === 'issue');
  const issueId = issue?.id ?? items[0]?.id ?? 'E1';
  const signalIds = items.filter((i) => i.kind === 'signal').slice(0, 3).map((i) => i.id);
  const probeItems = items.filter((i) => i.kind === 'probe' && i.name);
  const probe = (name: string) => probeItems.find((p) => p.name === name);
  const kind = typeof issue?.data?.kind === 'string' ? issue.data.kind : 'element';
  const anchor = typeof issue?.data?.anchor === 'string' ? issue.data.anchor : 'the control';
  const route = typeof issue?.data?.route === 'string' ? issue.data.route : 'the page';
  const qty = probe('qty');
  const line = probe('line_total');

  if (kind === 'element' && qty && qty.min === 0) {
    return {
      propose: true,
      sentence: PAIRS_PER_LINE_SENTENCE,
      assumptions: ['qty is the number of pairs on each bag line.', 'A line at quantity 0 should have left the bag.'],
      explanation: {
        text: `Shoppers keep pressing ${anchor} on ${route} with no effect, and in these sessions a bag line reports quantity 0 (qty min 0) yet stays in the bag${line ? ' with its own line total' : ''}. A line at quantity 0 should have left the bag, so a rule that every line holds at least one pair catches it without any price.`.slice(0, 600),
        evidence_ids: [issueId, ...signalIds, qty.id, ...(line ? [line.id] : [])],
      },
    };
  }

  const probeIds = probeItems.slice(0, 4).map((p) => p.id);
  const why =
    kind === 'invariant'
      ? `This issue is already a data rule (${anchor}), so a second rule would add nothing.`
      : probeItems.length === 0
        ? `No probe values were recorded in this issue's sessions, so there is no number a rule could check; ${anchor} not responding on ${route} is a behaviour, not a value.`
        : `The probe values in this issue's sessions (${probeItems
            .slice(0, 4)
            .map((p) => p.name)
            .join(', ')}) show nothing impossible for a shop, so a rule over them would not catch ${anchor} failing on ${route}.`;
  return { propose: false, sentence: '', assumptions: [], explanation: { text: `${why} ${OFFLINE_NOTE}`.slice(0, 600), evidence_ids: [issueId, ...probeIds] } };
}
