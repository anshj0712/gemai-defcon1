import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerDemoStore, STORE_DELAYS } from '../src/demo-store.js';

/** The synthetic shop backend, with a recording clock instead of real waits. All data is synthetic. */
function store() {
  const waits: number[] = [];
  const app = Fastify();
  registerDemoStore(app, { sleep: async (ms) => void waits.push(ms), random: () => 0.5 });
  return { app, waits };
}
const bugs = (list: string) => ({ 'x-demo-bugs': list });

describe('demo store', () => {
  it('accepts SAVE10 and nothing else', async () => {
    const { app } = store();
    expect((await app.inject({ method: 'POST', url: '/api/coupon', payload: { code: 'save10' } })).json()).toEqual({ ok: true, percent: 10 });
    expect((await app.inject({ method: 'POST', url: '/api/coupon', payload: { code: 'FREESHIP' } })).json()).toMatchObject({ ok: false });
  });

  it('answers the stock check fast, and slowly with slow_stock', async () => {
    const { app, waits } = store();
    await app.inject({ method: 'GET', url: '/api/stock?product=velocity-runner' });
    await app.inject({ method: 'GET', url: '/api/stock?product=velocity-runner', headers: bugs('slow_stock') });
    expect(waits).toEqual([STORE_DELAYS.stock, STORE_DELAYS.stockSlow]);
  });

  it('authorises payment, declines every card with card_declined, and times out the first try with slow_payment', async () => {
    const { app, waits } = store();
    const auth = (attempt: number, header: string) => app.inject({ method: 'POST', url: '/api/payment/authorize', payload: { attempt }, headers: bugs(header) });
    expect((await auth(1, '')).json()).toMatchObject({ ok: true });
    const declined = await auth(1, 'card_declined');
    // A decline is a 200 with ok false: a message on the page, not an HTTP error.
    expect(declined.statusCode).toBe(200);
    expect(declined.json()).toEqual({ ok: false, reason: 'card_declined' });
    expect((await auth(1, 'slow_payment')).json()).toEqual({ ok: false, reason: 'bank_timeout' });
    expect((await auth(2, 'slow_payment')).json()).toMatchObject({ ok: true });
    expect(waits).toEqual([STORE_DELAYS.authorize, STORE_DELAYS.authorize, STORE_DELAYS.authorizeSlow, STORE_DELAYS.authorize]);
  });

  it('lets the payment bugs take turns when both are live: timeout, then decline, then through', async () => {
    const { app, waits } = store();
    const auth = (attempt: number) => app.inject({ method: 'POST', url: '/api/payment/authorize', payload: { attempt }, headers: bugs('slow_payment,card_declined,checkout_error') });
    expect((await auth(1)).json()).toEqual({ ok: false, reason: 'bank_timeout' });
    expect((await auth(2)).json()).toEqual({ ok: false, reason: 'card_declined' });
    expect((await auth(3)).json()).toMatchObject({ ok: true });
    expect(waits).toEqual([STORE_DELAYS.authorizeSlow, STORE_DELAYS.authorize, STORE_DELAYS.authorize]);
  });

  it('fails checkout only for Northeast with checkout_error', async () => {
    const { app } = store();
    const order = (region: string, header: string) => app.inject({ method: 'POST', url: '/api/checkout', payload: { region }, headers: bugs(header) });
    expect((await order('Northeast', '')).json()).toEqual({ ok: true, order_id: 'CP-550000' });
    expect((await order('North', 'checkout_error')).statusCode).toBe(200);
    expect((await order('Northeast', 'checkout_error')).statusCode).toBe(500);
  });

  it('starts a support chat, unless support_down', async () => {
    const { app } = store();
    expect((await app.inject({ method: 'POST', url: '/api/support/session', payload: {} })).json()).toMatchObject({ ok: true });
    expect((await app.inject({ method: 'POST', url: '/api/support/session', payload: {}, headers: bugs('support_down,nope') })).statusCode).toBe(503);
  });
});
