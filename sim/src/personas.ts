import type { Page } from 'playwright';
import { clickInPlace, flushSdk, moveAndClick, sessionIdOf, typeInto, URLS, waitFor } from './browser.js';
import { pressesRemove, rng, touchesFirstLine, type SessionPlan } from './plan.js';

/** What a session did, for the ground truth. All shoppers and details are synthetic. */
export interface SessionOutcome {
  session_id: string;
  has_cart: boolean;
  /** Correct bag value in minor units (INR), read from the bag subtotal; null without a bag. */
  cart_value_minor: number | null;
  order_placed: boolean;
}

interface Ctx {
  page: Page;
  plan: SessionPlan;
  r: () => number;
  /** Fewer mouse-move steps than the e2e check: faster, still a visible path in the replay. */
  steps: number;
}

const pause = (c: Ctx, min: number, max: number) => c.page.waitForTimeout(Math.round(min + c.r() * (max - min)));
const click = (c: Ctx, selector: string) => moveAndClick(c.page, selector, { steps: c.steps, jitter: c.r });

/** "₹17,181.50" → 1718150. */
function minorFromText(text: string | null): number | null {
  const n = Number((text ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

async function start(c: Ctx): Promise<string> {
  await c.page.goto(`${URLS.shop}/?bugs=${c.plan.flags.join(',')}`);
  await click(c, '#consent-accept');
  return waitFor('the SDK to start', () => sessionIdOf(c.page), 20_000);
}

async function viewProduct(c: Ctx, id: string): Promise<void> {
  if (!(await c.page.locator(`[data-testid="product-${id}"]`).count())) await click(c, '[data-testid="nav-home"]');
  await click(c, `[data-testid="product-${id}"]`);
  await c.page.waitForSelector('#add-to-bag');
  await pause(c, 300, 900);
}

async function addToBag(c: Ctx, id: string, size: string): Promise<void> {
  await viewProduct(c, id);
  await click(c, `[data-testid="size-${size}"]`);
  await pause(c, 150, 400);
  await click(c, '#add-to-bag');
  await c.page.waitForSelector('[data-testid="toast-close"]');
  await pause(c, 200, 500);
  await click(c, '[data-testid="toast-close"]');
}

async function openBag(c: Ctx): Promise<number | null> {
  await click(c, '[data-testid="nav-cart"]');
  await c.page.waitForSelector('#apply-coupon');
  await pause(c, 400, 900);
  return minorFromText(await c.page.locator('#subtotal').textContent());
}

/** Each bag line's total, in bag order (minor units). */
async function linePrices(c: Ctx): Promise<number[]> {
  return (await c.page.locator('[data-cp-probe="line_total"]').allTextContents()).map((t) => minorFromText(t) ?? 0);
}

async function changeQuantity(c: Ctx): Promise<void> {
  const firstLine = touchesFirstLine(c.plan);
  for (let i = 0; i < c.plan.qtyIncrements; i++) {
    // The bag re-renders after each change, so the stepper is looked up again every time.
    const steppers = c.page.locator('[data-action="inc"]');
    const index = firstLine ? 0 : (await steppers.count()) - 1;
    await click(c, `[data-action="inc"] >> nth=${index}`);
    await pause(c, 350, 700);
  }
}

/**
 * Remove on the last line. With ghost_line on, the line stays in the bag at quantity 0 (₹0); the shopper stares
 * at it, then presses Remove again in a fast burst, and it no longer responds.
 */
async function removeLastLine(c: Ctx): Promise<void> {
  const dec = '[data-testid="qty-dec"]';
  // The bag re-renders after a change, so the button is looked up again before each use.
  const last = async () => `${dec} >> nth=${(await c.page.locator(dec).count()) - 1}`;
  await click(c, await last());
  await pause(c, 1500, 2500); // stares at a line that did not go away
  const target = await last();
  for (let i = 0; i < c.plan.removePresses; i++) {
    await clickInPlace(c.page, target);
    await c.page.waitForTimeout(250 + Math.round(c.r() * 150));
  }
  await pause(c, 1000, 2000);
}

/** One press per code; then extra presses (and maybe a fast burst) on whatever state the button is in. */
async function tryCodes(c: Ctx): Promise<void> {
  for (const code of c.plan.codes) {
    await typeInto(c.page, '#coupon-code', code, { steps: c.steps, replace: true });
    await pause(c, 200, 500);
    await click(c, '#apply-coupon');
    // Long enough for the coupon check (150 ms) and for each press to be judged on its own.
    await pause(c, 1000, 1300);
  }
  const extra = c.plan.extraPresses;
  for (let i = 0; i < extra; i++) {
    if (c.plan.rapidBurst && i >= extra - 3) {
      await clickInPlace(c.page, '#apply-coupon');
      await c.page.waitForTimeout(250 + Math.round(c.r() * 150));
    } else {
      await click(c, '#apply-coupon');
      await pause(c, 1000, 1300);
    }
  }
}

async function fillCheckout(c: Ctx): Promise<void> {
  await click(c, '#checkout');
  await c.page.waitForSelector('#checkout-form');
  const n = c.plan.index;
  await typeInto(c.page, '#name', `Test Shopper ${n}`, { steps: c.steps });
  await typeInto(c.page, '#email', `shopper${n}@example.com`, { steps: c.steps });
  await typeInto(c.page, '#phone', `+91 90000 ${String(10000 + n).slice(-5)}`, { steps: c.steps });
  await typeInto(c.page, '#address', `${1 + (n % 90)} Example Street`, { steps: c.steps });
  await c.page.selectOption('#region', c.plan.region);
  await typeInto(c.page, '#card', '4111 1111 1111 1111', { steps: c.steps });
  await typeInto(c.page, '#exp', '12/30', { steps: c.steps });
  await typeInto(c.page, '#cvv', '123', { steps: c.steps });
  await pause(c, 300, 700);
}

/** The page's document, typed minimally: these scripts compile without the DOM library. */
type PageDocument = { document: { getElementById(id: string): { textContent: string | null } | null } };

/** Press Place Order; true when the order went through. */
async function placeOrder(c: Ctx, inPlace = false): Promise<boolean> {
  await c.page.waitForSelector('#place-order:not([disabled])');
  if (inPlace) await clickInPlace(c.page, '#place-order');
  else await click(c, '#place-order');
  const outcome = await Promise.race([
    c.page.waitForURL(/\/order\//, { timeout: 8000 }).then(() => 'ordered' as const),
    // Runs in the page (serialized, so no outside references); polls every animation frame, so the
    // retry follows the error as fast as a frustrated shopper would.
    c.page
      .waitForFunction(() => ((globalThis as unknown as PageDocument).document.getElementById('checkout-error')?.textContent ?? '').length > 0, undefined, { timeout: 8000 })
      .then(() => 'failed' as const),
  ]);
  return outcome === 'ordered';
}

/** Let the last actions settle past every detector window, then send the final batch. */
async function finish(c: Ctx): Promise<void> {
  await c.page.waitForTimeout(2600);
  await flushSdk(c.page);
}

export async function runPlan(page: Page, plan: SessionPlan): Promise<SessionOutcome> {
  const c: Ctx = { page, plan, r: rng(plan.seed), steps: 8 };
  const session_id = await start(c);
  const out: SessionOutcome = { session_id, has_cart: false, cart_value_minor: null, order_placed: false };

  if (plan.persona === 'window_shopper') {
    for (const p of plan.products) {
      await viewProduct(c, p.id);
      if (c.r() < 0.5) await click(c, `[data-testid="size-${p.size}"]`);
      await pause(c, 500, 1500);
    }
    await finish(c);
    return out;
  }

  for (const p of plan.products) await addToBag(c, p.id, p.size);
  out.has_cart = true;
  out.cart_value_minor = await openBag(c);

  if (plan.persona === 'pair_buyer') {
    // The prices at quantity 1 are right; afterwards the bag shows the raised line at 100x (qty_price), so the
    // true value is worked out from these rather than read from the (wrong) subtotal.
    const prices = await linePrices(c);
    await changeQuantity(c);
    await pause(c, 1500, 3000); // stares at the price
    out.cart_value_minor = prices.reduce((a, b) => a + b, 0) + (prices[0] ?? 0) * plan.qtyIncrements;
  } else if (pressesRemove(plan)) {
    // line_remover, the only shopper who presses Remove. The subtotal read below is the line that stays
    // (the ghost line adds ₹0).
    await removeLastLine(c);
  } else if (plan.persona === 'bulk_buyer') {
    // Reach 2+ items (a second product, or a higher quantity), then the coupon: the bug drops the last item from the total.
    await changeQuantity(c);
    await tryCodes(c);
    await pause(c, 1500, 2500); // reads the summary
  } else {
    await tryCodes(c);
    if (plan.qtyIncrements > 0) await changeQuantity(c);
  }
  if (plan.persona !== 'pair_buyer') out.cart_value_minor = minorFromText(await page.locator('#subtotal').textContent()) ?? out.cart_value_minor;

  if (plan.abandon && plan.abandonAt === 'bag') {
    await finish(c);
    return out;
  }

  await fillCheckout(c);
  if (plan.persona === 'northeast_payer') {
    let ok = await placeOrder(c);
    // The payment fails; the shopper presses again, fast, as soon as the button is back.
    for (let i = 0; i < plan.retries && !ok; i++) {
      await page.waitForTimeout(120 + Math.round(c.r() * 160));
      ok = await placeOrder(c, true);
    }
    if (!ok && !plan.abandon) {
      await pause(c, 1500, 2500);
      await page.selectOption('#region', 'South');
      await pause(c, 400, 800);
      ok = await placeOrder(c);
    }
    out.order_placed = ok;
  } else if (!plan.abandon) {
    out.order_placed = await placeOrder(c);
  }
  await finish(c);
  return out;
}
