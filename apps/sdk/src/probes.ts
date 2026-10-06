import { CUSTOM_TAGS, type ProbePayloadShape } from '@cp/schema/tags';

/**
 * Probes: allowlisted elements whose numbers the merchant wants checked (cart total, line prices,
 * discount, quantities). Their text is parsed to numbers in the browser and only the numbers leave
 * it, as one `cp.probe` snapshot whenever the DOM under them settles and the numbers changed.
 */

export interface ProbeSpec {
  /** Lowercase name used by invariant rules, for example "cart_total". */
  name: string;
  /** CSS selector; every match contributes one value, in document order. */
  selector: string;
  /** money: parsed to minor units (default); count: parsed to an integer. */
  kind?: 'money' | 'count';
}

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_VALUES = 100;

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

/** "Qty 3" -> 3. */
export function parseCount(text: string): number | null {
  const m = /-?\d+/.exec(text);
  return m ? Number(m[0]) : null;
}

interface QueryRoot {
  querySelectorAll(selector: string): ArrayLike<{ textContent: string | null }>;
}

/** Read every probe's current numbers. Invalid probe names and unparsable elements are skipped. */
export function readProbes(root: QueryRoot, specs: readonly ProbeSpec[]): Record<string, number[]> {
  const values: Record<string, number[]> = {};
  for (const spec of specs) {
    if (!NAME.test(spec.name)) continue;
    let nodes: ArrayLike<{ textContent: string | null }>;
    try {
      nodes = root.querySelectorAll(spec.selector);
    } catch {
      continue;
    }
    const list: number[] = [];
    for (let i = 0; i < nodes.length && list.length < MAX_VALUES; i++) {
      const text = nodes[i]?.textContent ?? '';
      const v = spec.kind === 'count' ? parseCount(text) : parseMoney(text);
      if (v !== null && Number.isFinite(v)) list.push(v);
    }
    values[spec.name] = list;
  }
  return values;
}

/** Emits a snapshot only when the numbers differ from the last one emitted. */
export class ProbeSnapshotter {
  private last = '';

  constructor(
    private readonly read: () => Record<string, number[]>,
    private readonly emit: (payload: ProbePayloadShape) => void,
    private readonly currency?: string,
  ) {}

  check(): boolean {
    const values = this.read();
    const key = JSON.stringify(values);
    if (key === this.last) return false;
    const wasEmpty = this.last === '' || Object.values(JSON.parse(this.last) as Record<string, number[]>).every((v) => v.length === 0);
    const isEmpty = Object.values(values).every((v) => v.length === 0);
    this.last = key;
    if (isEmpty && wasEmpty) return false;
    this.emit({ values, ...(this.currency ? { currency: this.currency } : {}) });
    return true;
  }
}

/** Watch the page and snapshot the probes once the DOM has been quiet for `debounceMs`. */
export function watchProbes(
  win: Window,
  specs: readonly ProbeSpec[],
  emit: (tag: string, payload: unknown) => void,
  opts: { currency?: string; debounceMs?: number } = {},
): () => void {
  const snap = new ProbeSnapshotter(() => readProbes(win.document, specs), (p) => emit(CUSTOM_TAGS.probe, p), opts.currency);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => snap.check(), opts.debounceMs ?? 250);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(win.document.documentElement, { subtree: true, childList: true, characterData: true });
  schedule();
  return () => {
    clearTimeout(timer);
    observer.disconnect();
  };
}
