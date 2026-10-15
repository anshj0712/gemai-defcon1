import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The bugs the synthetic demo shop can switch on. The shop and the dashboard both follow this list. */
export const DEMO_BUGS = [
  { id: 'dead_button', label: 'Dead button', detail: 'Apply Coupon silently stops responding after the 3rd press' },
  { id: 'cart_total', label: 'Cart total', detail: '2+ items in the bag (same or different shoes) and SAVE10 applied: the total leaves out the last item' },
  { id: 'checkout_error', label: 'Checkout error', detail: 'Region Northeast fails at payment (500 and a JS error)' },
  { id: 'qty_price', label: 'Quantity price', detail: 'A bag line with quantity 2+ shows 100x its price; totals agree, so no built-in rule fires (found later by a merchant rule)' },
] as const;

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
