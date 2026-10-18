import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isDemoBug, type DemoBugId } from './demo-bugs.js';

/**
 * The synthetic demo shop's backend: coupon check, stock check, payment authorisation, checkout, and the
 * support chat. All data is made up and nothing is charged. Bug flags travel in the `x-demo-bugs` header
 * (the shop sends the set it follows), so one API serves shop tabs with different bugs at the same time.
 *
 * It lives in the API rather than the shop's dev server so a deployed shop (static files) still has a
 * backend: enabled in local mode or with DEMO_STORE=true.
 */

export interface DemoStoreOptions {
  /** Injected in tests so the slow bugs do not slow the suite. */
  sleep?: (ms: number) => Promise<void>;
  /** Order ids only. */
  random?: () => number;
}

/** How long each call takes, normally and with its slow bug on (milliseconds). */
export const STORE_DELAYS = {
  coupon: 150,
  stock: 150,
  stockSlow: 4000,
  authorize: 250,
  authorizeSlow: 6500,
  checkout: 300,
  support: 200,
} as const;

const CouponBody = z.object({ code: z.string().max(40).default('') });
const AuthorizeBody = z.object({ total_minor: z.number().int().nonnegative().optional(), attempt: z.number().int().min(1).max(20).default(1) });
const CheckoutBody = z.object({ region: z.string().max(40).default(''), total_minor: z.number().int().nonnegative().optional() });

function bugsOf(req: FastifyRequest): Set<DemoBugId> {
  const raw = req.headers['x-demo-bugs'];
  const text = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
  return new Set(text.split(',').map((s) => s.trim()).filter(isDemoBug));
}

export function registerDemoStore(app: FastifyInstance, opts: DemoStoreOptions = {}): void {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const noStore = { 'cache-control': 'no-store' };

  app.post('/api/coupon', async (req, reply) => {
    const body = CouponBody.safeParse(req.body ?? {});
    await sleep(STORE_DELAYS.coupon);
    const code = body.success ? body.data.code.trim().toUpperCase() : '';
    return reply.headers(noStore).send(code === 'SAVE10' ? { ok: true, percent: 10 } : { ok: false, reason: 'unknown_code' });
  });

  // BUG slow_stock: the stock check behind Add to Bag takes 4 s instead of 150 ms.
  app.get('/api/stock', async (req, reply) => {
    await sleep(bugsOf(req).has('slow_stock') ? STORE_DELAYS.stockSlow : STORE_DELAYS.stock);
    return reply.headers(noStore).send({ in_stock: true, synthetic: true });
  });

  // Payment authorisation, before the order is placed. Answers are 200 with ok:false (as many gateways do), so
  // a decline or a timeout is a message on the page rather than an HTTP error.
  app.post('/api/payment/authorize', async (req, reply) => {
    const bugs = bugsOf(req);
    const body = AuthorizeBody.safeParse(req.body ?? {});
    const attempt = body.success ? body.data.attempt : 1;
    // With both payment bugs live they take turns, so each shows: the 1st try times out, the 2nd is declined, the 3rd
    // goes through (and checkout_error can then fail a Northeast order). Alone, each behaves as described below.
    // BUG slow_payment: the first attempt hangs for 6.5 s, then the bank times out; a retry goes through.
    if (bugs.has('slow_payment') && attempt === 1) {
      await sleep(STORE_DELAYS.authorizeSlow);
      return reply.headers(noStore).send({ ok: false, reason: 'bank_timeout' });
    }
    // BUG card_declined: every card is declined (and the shop's "Use another card" button is dead).
    if (bugs.has('card_declined') && !(bugs.has('slow_payment') && attempt > 2)) {
      await sleep(STORE_DELAYS.authorize);
      return reply.headers(noStore).send({ ok: false, reason: 'card_declined' });
    }
    await sleep(STORE_DELAYS.authorize);
    return reply.headers(noStore).send({ ok: true, auth_id: `AUTH-${Math.floor(100000 + random() * 900000)}` });
  });

  // BUG checkout_error: the Northeast region gets a 500 (the shop also throws).
  app.post('/api/checkout', async (req, reply) => {
    const body = CheckoutBody.safeParse(req.body ?? {});
    await sleep(STORE_DELAYS.checkout);
    if (bugsOf(req).has('checkout_error') && body.success && body.data.region === 'Northeast') {
      return reply.code(500).headers(noStore).send({ ok: false, error: 'payment_gateway_unavailable' });
    }
    return reply.headers(noStore).send({ ok: true, order_id: `CP-${Math.floor(100000 + random() * 900000)}` });
  });

  // BUG support_down: the support chat cannot start a conversation (503; the shop also throws).
  app.post('/api/support/session', async (req, reply) => {
    await sleep(STORE_DELAYS.support);
    if (bugsOf(req).has('support_down')) return reply.code(503).headers(noStore).send({ ok: false, error: 'support_unavailable' });
    return reply.headers(noStore).send({ ok: true, agent: 'Asha (synthetic)', wait_minutes: 2 });
  });
}
