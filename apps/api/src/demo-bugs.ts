import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Why shoppers leave, as the bugs below are grouped (the churn reasons a store hears about most). */
export const CHURN_REASONS = {
  ux: 'Poor user experience',
  price: 'Price trust',
  shipping_cost: 'Shipping cost',
  delivery_time: 'Delivery time',
  returns: 'Returns hassle',
  support: 'Customer service',
  personalization: 'Personalization',
  payment_declined: 'Declined card',
  payment_gateway: 'Payment gateway',
} as const;
export type ChurnReasonId = keyof typeof CHURN_REASONS;

/** How a bug is caught: a live detector, a built-in rule, a merchant's rule, or a probe and rule the agent proposes. */
export type CaughtBy = 'detector' | 'builtin_rule' | 'merchant_rule' | 'agent_rule' | 'agent';

export interface DemoBug {
  id: string;
  label: string;
  detail: string;
  reason: ChurnReasonId;
  caught: CaughtBy;
  /** One line on how the pipeline sees it. */
  caught_detail: string;
}

/** The bugs the synthetic demo shop can switch on. The shop and the dashboard both follow this list. */
export const DEMO_BUGS = [
  { id: 'dead_button', label: 'Dead button', reason: 'ux', caught: 'detector', detail: 'Apply Coupon silently stops responding after the 3rd press', caught_detail: 'dead clicks, live' },
  { id: 'ghost_line', label: 'Ghost line', reason: 'ux', caught: 'agent_rule', detail: 'Remove leaves a bag line at quantity 0 (₹0) and then stops responding', caught_detail: 'dead clicks live; the agent suggests a rule' },
  { id: 'slow_stock', label: 'Slow stock check', reason: 'ux', caught: 'agent', detail: 'Add to Bag waits 4 s for a stock check instead of 150 ms', caught_detail: 'the agent proposes a speed rule on the request' },
  { id: 'cart_total', label: 'Cart total', reason: 'price', caught: 'builtin_rule', detail: '2+ items in the bag and SAVE10 applied: the total leaves out the last item', caught_detail: 'built-in rule, live' },
  { id: 'qty_price', label: 'Quantity price', reason: 'price', caught: 'merchant_rule', detail: 'A bag line with quantity 2+ shows 100x its price; totals agree', caught_detail: 'found later by a merchant rule' },
  { id: 'shipping_shock', label: 'Shipping shock', reason: 'shipping_cost', caught: 'agent', detail: 'The bag says free delivery; checkout adds ₹499 delivery and handling', caught_detail: 'the agent proposes a probe on the fee and a rule' },
  { id: 'slow_delivery', label: 'Slow delivery', reason: 'delivery_time', caught: 'agent', detail: 'The product page promises delivery in 9–12 days instead of 2–4', caught_detail: 'the agent proposes a probe on the estimate and a rule' },
  { id: 'returns_hidden', label: 'Returns hidden', reason: 'returns', caught: 'detector', detail: 'The Returns policy button on the product page does nothing', caught_detail: 'dead clicks, live' },
  { id: 'support_down', label: 'Support down', reason: 'support', caught: 'detector', detail: 'Chat with us at checkout fails (503 and a JS error)', caught_detail: 'error after a click, live' },
  { id: 'recs_sold_out', label: 'Sold-out picks', reason: 'personalization', caught: 'detector', detail: 'Picked for you suggests sold-out shoes; Quick add does nothing', caught_detail: 'dead clicks, live' },
  { id: 'card_declined', label: 'Card declined', reason: 'payment_declined', caught: 'detector', detail: 'Every card is declined, and Use another card does nothing', caught_detail: 'dead clicks, live' },
  { id: 'checkout_error', label: 'Checkout error', reason: 'payment_gateway', caught: 'detector', detail: 'Region Northeast fails at payment (500 and a JS error)', caught_detail: 'error after a click and rage clicks, live' },
  { id: 'slow_payment', label: 'Slow bank', reason: 'payment_gateway', caught: 'agent', detail: 'Payment authorisation hangs 6.5 s, then the bank times out', caught_detail: 'the agent proposes a speed rule on the request' },
] as const satisfies readonly DemoBug[];

export type DemoBugId = (typeof DEMO_BUGS)[number]['id'];
const IDS: readonly string[] = DEMO_BUGS.map((b) => b.id);
export const isDemoBug = (s: unknown): s is DemoBugId => typeof s === 'string' && IDS.includes(s);

/** Which bugs are live in the demo shop. Local mode only: one small file next to the other `.data/` stand-ins. */
export interface DemoBugStore {
  read(): DemoBugId[];
  write(bugs: readonly DemoBugId[]): DemoBugId[];
}

export function createFileDemoBugStore(path: string): DemoBugStore {
  const normalize = (bugs: readonly unknown[]): DemoBugId[] => IDS.filter((id) => bugs.includes(id)) as DemoBugId[];
  return {
    read() {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        return Array.isArray(parsed) ? normalize(parsed) : [];
      } catch {
        return [];
      }
    },
    write(bugs) {
      const next = normalize(bugs);
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(next));
      renameSync(tmp, path);
      return next;
    },
  };
}
