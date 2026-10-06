import { EventType, IncrementalSource, MouseInteractions, NodeType } from '@rrweb/types';
import { CUSTOM_TAGS, type IngestEnvelope, type RrwebEvent } from '@cp/schema';

/**
 * Synthetic rrweb sessions for tests and the local smoke run. All data here is synthetic.
 * The page is a small cart: a coupon form, a total, a checkout button, a disabled button, a
 * promo banner (not interactive), a country <select>, and a help link.
 */

export const NODE = {
  document: 1,
  doctype: 2,
  html: 3,
  head: 4,
  body: 5,
  app: 6,
  couponForm: 7,
  couponInput: 8,
  applyCoupon: 9,
  applyCouponLabel: 10,
  applyCouponText: 11,
  total: 12,
  totalText: 13,
  checkout: 14,
  checkoutText: 15,
  disabledButton: 16,
  disabledText: 17,
  promoBanner: 18,
  promoText: 19,
  countrySelect: 20,
  helpLink: 21,
  helpText: 22,
} as const;

type SNode = Record<string, unknown>;

const el = (id: number, tagName: string, attributes: Record<string, string | true> = {}, childNodes: SNode[] = []): SNode => ({
  type: NodeType.Element,
  id,
  tagName,
  attributes,
  childNodes,
});
const text = (id: number, textContent: string): SNode => ({ type: NodeType.Text, id, textContent });

/** Serialized DOM of the cart page, as rrweb's FullSnapshot would carry it. */
export function cartDocument(): SNode {
  return {
    type: NodeType.Document,
    id: NODE.document,
    childNodes: [
      { type: NodeType.DocumentType, id: NODE.doctype, name: 'html', publicId: '', systemId: '' },
      el(NODE.html, 'html', {}, [
        el(NODE.head, 'head'),
        el(NODE.body, 'body', {}, [
          el(NODE.app, 'div', { id: 'app' }, [
            el(NODE.couponForm, 'form', { id: 'coupon-form', class: 'coupon' }, [
              el(NODE.couponInput, 'input', { id: 'coupon-code', type: 'text', value: '' }),
              el(NODE.applyCoupon, 'button', { id: 'apply-coupon', type: 'button', class: 'btn css-1x2y3z' }, [
                el(NODE.applyCouponLabel, 'span', { class: 'label' }, [text(NODE.applyCouponText, 'Apply Coupon')]),
              ]),
            ]),
            el(NODE.total, 'div', { class: 'cart-total' }, [text(NODE.totalText, '1299.00')]),
            el(NODE.checkout, 'button', { id: 'checkout', class: 'btn btn-primary' }, [text(NODE.checkoutText, 'Checkout')]),
            el(NODE.disabledButton, 'button', { id: 'place-order', disabled: true }, [text(NODE.disabledText, 'Place order')]),
            el(NODE.promoBanner, 'div', { class: 'promo-banner' }, [text(NODE.promoText, 'Save 10% today')]),
            el(NODE.countrySelect, 'select', { id: 'country', name: 'country' }),
            el(NODE.helpLink, 'a', { href: '/help', class: 'help' }, [text(NODE.helpText, 'Help')]),
          ]),
        ]),
      ]),
    ],
  };
}

/** Builds an rrweb event list with times given as offsets from `start`. */
export class SessionScript {
  readonly events: RrwebEvent[] = [];

  constructor(readonly start: number) {}

  private push(offsetMs: number, type: number, data: Record<string, unknown>): this {
    this.events.push({ type, timestamp: this.start + offsetMs, data } as RrwebEvent);
    return this;
  }

  meta(offsetMs: number, href = 'http://localhost:5173/cart'): this {
    return this.push(offsetMs, EventType.Meta, { href, width: 1280, height: 800 });
  }

  snapshot(offsetMs: number, node: SNode = cartDocument()): this {
    return this.push(offsetMs, EventType.FullSnapshot, { node, initialOffset: { top: 0, left: 0 } });
  }

  click(offsetMs: number, id: number, x = 100, y = 200): this {
    return this.push(offsetMs, EventType.IncrementalSnapshot, { source: IncrementalSource.MouseInteraction, type: MouseInteractions.Click, id, x, y });
  }

  mutateText(offsetMs: number, id: number, value: string): this {
    return this.push(offsetMs, EventType.IncrementalSnapshot, { source: IncrementalSource.Mutation, texts: [{ id, value }], attributes: [], removes: [], adds: [] });
  }

  mutateAttributes(offsetMs: number, id: number, attributes: Record<string, string | null>): this {
    return this.push(offsetMs, EventType.IncrementalSnapshot, { source: IncrementalSource.Mutation, texts: [], attributes: [{ id, attributes }], removes: [], adds: [] });
  }

  addNodes(offsetMs: number, adds: { parentId: number; nextId: number | null; node: SNode }[]): this {
    return this.push(offsetMs, EventType.IncrementalSnapshot, { source: IncrementalSource.Mutation, texts: [], attributes: [], removes: [], adds });
  }

  input(offsetMs: number, id: number, textValue = '*****'): this {
    return this.push(offsetMs, EventType.IncrementalSnapshot, { source: IncrementalSource.Input, id, text: textValue, isChecked: false });
  }

  net(offsetMs: number, payload: { phase?: 'start' | 'end'; method?: string; route: string; status?: number; duration_ms?: number }): this {
    return this.push(offsetMs, EventType.Custom, { tag: CUSTOM_TAGS.net, payload: { method: 'POST', ...payload } });
  }

  nav(offsetMs: number, reason: 'spa' | 'unload', route?: string): this {
    return this.push(offsetMs, EventType.Custom, { tag: CUSTOM_TAGS.nav, payload: { reason, ...(route ? { route } : {}) } });
  }

  /** A probe snapshot as the SDK emits it: every probe's parsed numbers (money in minor units). */
  probe(offsetMs: number, values: Record<string, number[]>, currency = 'INR'): this {
    return this.push(offsetMs, EventType.Custom, { tag: CUSTOM_TAGS.probe, payload: { values, currency } });
  }

  /** Any rrweb Custom event, for testing malformed or unknown payloads. */
  custom(offsetMs: number, tag: string, payload: unknown): this {
    return this.push(offsetMs, EventType.Custom, { tag, payload });
  }

  jsError(offsetMs: number, signature: string, kind: 'error' | 'unhandledrejection' = 'unhandledrejection'): this {
    return this.push(offsetMs, EventType.Custom, { tag: CUSTOM_TAGS.error, payload: { kind, signature } });
  }
}

export interface EnvelopeOptions {
  sessionId: string;
  siteKey?: string;
  /** Batch length; events are grouped into consecutive windows of this size from `start`. */
  batchMs?: number;
  /** Session start (window origin). Defaults to the first event's timestamp. */
  start?: number;
  /** End of the last window, i.e. the final flush time. Defaults to the end of the last window. */
  end?: number;
  route?: string;
  urlPath?: string;
  release?: string;
  /** How long after a window ends the SDK sends it. */
  sendLagMs?: number;
  /** Added to every client timestamp, to simulate a browser clock that is off. */
  clockOffsetMs?: number;
}

/** Split a script's events into SDK batches. Windows with no events are not sent. */
export function toEnvelopes(events: readonly RrwebEvent[], opts: EnvelopeOptions): IngestEnvelope[] {
  if (events.length === 0) return [];
  const batchMs = opts.batchMs ?? 5000;
  const start = opts.start ?? events[0]!.timestamp;
  const offset = opts.clockOffsetMs ?? 0;
  const windows = new Map<number, RrwebEvent[]>();
  for (const e of events) {
    const w = Math.floor((e.timestamp - start) / batchMs);
    windows.set(w, [...(windows.get(w) ?? []), { ...e, timestamp: e.timestamp + offset }]);
  }
  const indexes = [...windows.keys()].sort((a, b) => a - b);
  return indexes.map((w, seq) => {
    const tsStart = start + w * batchMs + offset;
    const isLast = seq === indexes.length - 1;
    const tsEnd = (isLast && opts.end !== undefined ? opts.end : start + (w + 1) * batchMs) + offset;
    return {
      site_key: opts.siteKey ?? 'pk_local_demo',
      session_id: opts.sessionId,
      seq,
      client_ts_start: tsStart,
      client_ts_end: tsEnd,
      client_sent_at: tsEnd + (opts.sendLagMs ?? 50),
      sdk_version: '0.1.0-testkit',
      release: opts.release ?? 'git:testkit',
      sample_rate: 1,
      page: { route: opts.route ?? '/cart', url_path: opts.urlPath ?? '/cart' },
      events: windows.get(w)!,
      business_events: seq === 0 ? [{ name: 'cart_viewed', value_minor: 129900, currency: 'INR' }] : [],
    };
  });
}

export interface ApplyCouponScenario {
  events: RrwebEvent[];
  /** Clicks (0-based) that get no response. */
  deadClickIndexes: number[];
  clickTimes: number[];
  end: number;
}

/**
 * The BUG_DEAD_BUTTON story: Apply Coupon answers its first `respondFirst` clicks (request plus a
 * total update), then silently stops. Clicks land on the <span> inside the button, as real ones do.
 */
export function applyCouponScenario(opts: { start: number; clicks?: number; respondFirst?: number; gapMs?: number }): ApplyCouponScenario {
  const clicks = opts.clicks ?? 7;
  const respondFirst = opts.respondFirst ?? 5;
  const gapMs = opts.gapMs ?? 1200;
  const s = new SessionScript(opts.start).meta(0).snapshot(5);
  const clickTimes: number[] = [];
  const deadClickIndexes: number[] = [];
  for (let i = 0; i < clicks; i++) {
    const t = 1000 + i * gapMs;
    s.click(t, NODE.applyCouponLabel);
    clickTimes.push(opts.start + t);
    if (i < respondFirst) {
      s.net(t + 5, { phase: 'start', route: '/api/coupon' });
      s.net(t + 180, { phase: 'end', route: '/api/coupon', status: 200, duration_ms: 175 });
      s.mutateText(t + 200, NODE.totalText, `${1299 - (i + 1) * 10}.00`);
    } else {
      deadClickIndexes.push(i);
    }
  }
  const end = opts.start + 1000 + clicks * gapMs + 1000;
  s.nav(end - opts.start - 10, 'unload');
  return { events: s.events, deadClickIndexes, clickTimes, end };
}

/** A batch carrying every kind of PII the collector must scrub. Synthetic values only. */
export function piiEnvelope(start: number): IngestEnvelope {
  const doc = {
    type: NodeType.Document,
    id: 1,
    childNodes: [
      el(2, 'html', {}, [
        el(3, 'body', {}, [
          el(4, 'p', { class: 'account' }, [text(5, 'Signed in as asha.rao@example.com, call +91 98765 43210')]),
          el(6, 'input', { id: 'card', type: 'text', value: '4111 1111 1111 1111' }),
          el(7, 'input', { id: 'csrf', type: 'hidden', value: 'secret-hidden-token' }),
          el(8, 'textarea', { id: 'notes' }, [text(9, 'deliver to flat 4B, my number is 9876543210')]),
          el(10, 'a', { href: 'https://shop.example.com/orders?token=abc123&email=asha@example.com#frag' }, [text(11, 'Orders')]),
          el(12, 'p', { class: 'confirmation' }, [text(13, 'Paid with card 4000-0566-5566-5556')]),
        ]),
      ]),
    ],
  };
  return {
    site_key: 'pk_local_demo',
    session_id: 's_pii_fixture_01',
    seq: 0,
    client_ts_start: start,
    client_ts_end: start + 5000,
    client_sent_at: start + 5050,
    sdk_version: '0.1.0-testkit',
    release: 'git:testkit',
    page: { route: '/checkout', url_path: '/checkout?coupon=SAVE10&email=asha@example.com' },
    events: [
      { type: EventType.Meta, timestamp: start, data: { href: 'https://shop.example.com/checkout?session=xyz#pay', width: 1280, height: 800 } },
      { type: EventType.FullSnapshot, timestamp: start + 5, data: { node: doc, initialOffset: { top: 0, left: 0 } } },
      { type: EventType.IncrementalSnapshot, timestamp: start + 100, data: { source: IncrementalSource.Input, id: 6, text: '4111111111111111', isChecked: false } },
      {
        type: EventType.IncrementalSnapshot,
        timestamp: start + 200,
        data: { source: IncrementalSource.Mutation, texts: [{ id: 5, value: 'Contact: ravi@example.org' }], attributes: [{ id: 7, attributes: { value: 'another-hidden-secret' } }], removes: [], adds: [] },
      },
      { type: EventType.Custom, timestamp: start + 300, data: { tag: CUSTOM_TAGS.net, payload: { phase: 'end', method: 'GET', route: '/api/orders?email=asha@example.com', status: 200, duration_ms: 20 } } },
    ] as RrwebEvent[],
    business_events: [],
  };
}
