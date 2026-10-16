import type { ChurnAnalystOutput, ChurnReason } from '@cp/schema';

/**
 * The offline stand-in's churn analyst: a template, not a language model. It labels a candidate from the words
 * in its name, selector and page (fee, delivery, payment, stock...) and writes the rule in the one form the
 * offline rule author understands ("<probe> must never be more than <limit>"). Anything it cannot place is
 * declined with a grounded reason and a pointer to GOOGLE_API_KEY.
 */

interface Candidate {
  id: string;
  kind: string;
  number?: { name?: string; source?: string; selector?: string | null; page?: string | null; unit?: string };
  direction?: string;
  threshold?: number;
  suggested_limit?: number;
  segment?: { sessions?: number; abandonment?: number };
  others?: { sessions?: number; abandonment?: number };
}

const pct = (x: number | undefined) => `${Math.round((x ?? 0) * 100)}%`;
const rupees = (minor: number) => `₹${(minor / 100).toLocaleString('en-IN')}`;
const NOTE = 'Offline stand-in (templated); set GOOGLE_API_KEY to let Gemini judge.';

/** The path part of a request probe name: `req_post_api_payment_authorize_ms` -> `post /api/payment/authorize`. */
function requestLabel(name: string): string {
  const core = name.replace(/^req_/, '').replace(/_(ms|status)$/, '');
  const [method, ...rest] = core.split('_');
  return `${(method ?? '').toUpperCase()} /${rest.join('/')}`;
}

export function offlineChurnAnalyst(payload: { evidence?: Candidate[] }): ChurnAnalystOutput {
  const h = (payload.evidence ?? []).find((e) => e.kind === 'candidate');
  const n = h?.number ?? {};
  const name = n.name ?? '';
  const words = `${name} ${n.selector ?? ''} ${n.page ?? ''}`.toLowerCase();
  const unit = n.unit ?? 'count';
  const discovered = n.source === 'discovered';
  const threshold = h?.threshold ?? 0;
  const limit = h?.suggested_limit ?? 0;
  const gte = (h?.direction ?? '').includes('above');
  const seg = h?.segment ?? {};
  const others = h?.others ?? {};
  const gap = (seg.abandonment ?? 0) - (others.abandonment ?? 0);

  const decline = (why: string): ChurnAnalystOutput => ({
    propose: false,
    churn_reason: 'other',
    title: '',
    hypothesis: { text: `${why} ${NOTE}`.slice(0, 600), evidence_ids: ['H1'] },
    probe_name: '',
    sentence: '',
    confidence: 'low',
    assumptions: [],
  });

  let reason: ChurnReason | null = null;
  let title = '';
  let thresholdText = '';
  let what = '';
  if (unit === 'ms') {
    const label = requestLabel(name);
    const payment = /(pay|authori|bank|card)/.test(words);
    reason = payment ? 'payment_gateway' : 'ux';
    thresholdText = `${(threshold / 1000).toFixed(1)} s`;
    what = `the ${label} call`;
    title = payment ? `Payment authorisation takes ${thresholdText} or more` : `${label} takes ${thresholdText} or more`;
  } else if (unit === 'status') {
    reason = /(pay|checkout|order|authori)/.test(words) ? 'payment_gateway' : 'ux';
    thresholdText = String(threshold);
    what = `the ${requestLabel(name)} call`;
    title = `${requestLabel(name)} fails with HTTP ${threshold}`;
  } else if (unit === 'money') {
    thresholdText = rupees(threshold);
    if (/(ship|deliver|handling|postage|freight)/.test(words)) {
      reason = 'shipping_cost';
      what = 'the delivery fee shown at checkout';
      title = `Unexpected ${thresholdText} delivery fee at checkout`;
    } else if (/(fee|charge|surcharge|tax)/.test(words)) {
      reason = 'price';
      what = 'an extra charge';
      title = `Unexpected ${thresholdText} charge`;
    } else if (/(price|total|line|subtotal|amount)/.test(words)) {
      reason = 'price';
      what = `the amount shown (${name})`;
      title = `${name.replace(/_/g, ' ')} far above normal (${thresholdText} or more)`;
    }
  } else if (/(eta|deliver|arriv|dispatch|days)/.test(words)) {
    reason = 'delivery_time';
    thresholdText = `${threshold} days`;
    what = 'the delivery estimate';
    title = `Delivery estimate of ${threshold}+ days`;
  }
  if (!reason || !gte) return decline(`Nothing in ${name || 'this number'} (${n.selector ?? n.page ?? 'no selector'}) says it is something a shopper sees or waits for, so a ${pct(gap)} gap in abandonment may be a coincidence of who browses where.`);

  const limitText = unit === 'money' ? rupees(limit) : unit === 'ms' ? `${limit} ms` : String(limit);
  return {
    propose: true,
    churn_reason: reason,
    title: title.slice(0, 90),
    hypothesis: {
      text: `Shoppers who met ${what} at ${thresholdText} or more left ${pct(seg.abandonment)} of the time (${seg.sessions ?? 0} sessions), against ${pct(others.abandonment)} for everyone else (${others.sessions ?? 0}): a gap very unlikely to be chance. ${NOTE}`.slice(0, 600),
      evidence_ids: ['H1'],
    },
    probe_name: discovered ? name : '',
    sentence: `The ${name} must never be more than ${limitText}.`,
    confidence: gap >= 0.45 ? 'high' : 'medium',
    assumptions: ['The shoppers in the segment saw (or waited for) this number before they left.', ...(unit === 'money' ? ['Money has two decimal places (minor units = amount x 100).'] : [])],
  };
}
