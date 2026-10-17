import '@fontsource-variable/inter';
import '@fontsource-variable/oswald';
import './styles.css';
import { init, type CpClient } from '@cp/sdk';
import { BRAND, CATEGORIES, PRODUCTS, SIZES, money, productById, shoeSvg, type Product } from './catalog';
import { isBug, pickSessionBugs, type Bug } from './bugs';
import { icons } from './icons';

/**
 * STRIDE: a synthetic store for exercising the pipeline (all data is made up). Thirteen bugs, one or more per
 * common churn reason. Each tab draws a random, compatible set of them (bugs.ts); `?bugs=dead_button,...` forces a
 * set instead. The store's backend is the API's synthetic store (apps/api/src/demo-store.ts).
 *   dead_button     Apply Coupon silently stops responding after the third click
 *   ghost_line      Remove leaves a bag line in the bag at quantity 0 (₹0) and then stops responding; totals agree, so
 *                   no built-in rule fires (the agent suggests one)
 *   slow_stock      the stock check behind Add to Bag takes 4 s (the agent proposes a speed rule)
 *   cart_total      with a discount applied and 2+ items in the bag (same shoe or different), the total skips the last item
 *   qty_price       a line with quantity 2+ shows 100x its price (paise as rupees); the totals agree with it, so only a
 *                   merchant rule written later catches it (the Phase 4 found-later demo)
 *   shipping_shock  the bag says delivery is free; checkout adds ₹499 delivery and handling (the agent proposes a probe)
 *   slow_delivery   the product page promises delivery in 9–12 days instead of 2–4 (the agent proposes a probe)
 *   returns_hidden  the Returns policy button on the product page does nothing
 *   support_down    Chat with us at checkout fails with a 503 and a JS error
 *   recs_sold_out   Picked for you (bag) suggests sold-out shoes, and Quick add does nothing
 *   card_declined   every card is declined at payment, and Use another card does nothing
 *   checkout_error  the Northeast region gets a 500 and a JS error at payment
 *   slow_payment    payment authorisation hangs 6.5 s, then the bank times out (the agent proposes a speed rule)
 *
 * Rule for this file: every clickable element must visibly do something (navigate, change the
 * page, or make a request). A control that silently does nothing is a real dead click, and only
 * the deliberate bugs above may have one.
 */

declare global {
  interface Window {
    cp?: CpClient;
  }
}

// ---------------------------------------------------------------------------------------------
// Bug flags and the recorder
// ---------------------------------------------------------------------------------------------

/**
 * Which bugs are live in this tab. An explicit ?bugs= in the URL (the simulator and e2e use it, even empty) wins.
 * Otherwise a fresh tab draws its own random, compatible set once (see bugs.ts), kept for the whole tab session,
 * so every shopper meets a different mix and some meet none.
 */
function loadBugs(): Set<Bug> {
  const fromUrl = new URLSearchParams(location.search).get('bugs');
  if (fromUrl !== null) sessionStorage.setItem('demo_bugs', fromUrl);
  if (sessionStorage.getItem('demo_bugs') === null) sessionStorage.setItem('demo_bugs', pickSessionBugs().join(','));
  return new Set((sessionStorage.getItem('demo_bugs') ?? '').split(',').filter(isBug));
}
const bugs = loadBugs();

const DASHBOARD_URL = import.meta.env.VITE_CP_DASHBOARD ?? 'http://localhost:5174';
const cp = init({
  siteKey: import.meta.env.VITE_CP_SITE_KEY ?? 'pk_local_demo',
  collectorUrl: import.meta.env.VITE_CP_COLLECTOR ?? 'http://localhost:8080',
  release: 'demo-shop@local',
  // One route per page type, so a problem on every product page is one issue, not one per shoe.
  routeFor: (path) => (path.startsWith('/product/') ? '/product/:id' : path.startsWith('/order/') ? '/order/:id' : path),
  // Numbers the invariant rules check (cart total = line totals - discount). Only parsed numbers leave the browser.
  probes: [
    { name: 'cart_total', selector: '[data-cp-probe="cart_total"]' },
    { name: 'line_total', selector: '[data-cp-probe="line_total"]' },
    { name: 'discount', selector: '[data-cp-probe="discount"]' },
    { name: 'qty', selector: '[data-cp-probe="qty"]', kind: 'count' },
  ],
  currency: 'INR',
  consent: localStorage.getItem('cp_consent') === 'granted' ? 'granted' : 'pending',
});
window.cp = cp;

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

interface Line {
  id: string;
  size: string;
  qty: number;
}

const state = {
  bag: (JSON.parse(sessionStorage.getItem('stride_bag') ?? '[]') as Line[]).filter((l) => productById(l.id)),
  discountPct: Number(sessionStorage.getItem('stride_discount') ?? '0'),
  favourites: new Set<string>(JSON.parse(localStorage.getItem('stride_favs') ?? '[]') as string[]),
  couponClicks: 0,
  query: '',
  sort: 'featured' as 'featured' | 'price-asc' | 'price-desc',
  selectedSize: null as string | null,
  view: 'side' as 'side' | 'mirror' | 'tilt' | 'detail',
  sizeAttempts: 0,
  /** Payment authorisations tried on this visit to checkout (slow_payment hangs only the first). */
  authAttempts: 0,
};

/** BUG shipping_shock: what checkout adds for delivery and handling, though the bag says delivery is free. */
const SHOCK_DELIVERY_MINOR = 49900;
/** The delivery estimate the product page promises, in business days (BUG slow_delivery: 9–12). */
const deliveryWindow = () => (bugs.has('slow_delivery') ? '9–12' : '2–4');
/** The size Quick add picks: in stock for every shoe in the catalog. */
const QUICK_ADD_SIZE = 'UK 9';

const lineKey = (l: Pick<Line, 'id' | 'size'>) => `${l.id}|${l.size}`;

function persist(): void {
  sessionStorage.setItem('stride_bag', JSON.stringify(state.bag));
  sessionStorage.setItem('stride_discount', String(state.discountPct));
  localStorage.setItem('stride_favs', JSON.stringify([...state.favourites]));
  const count = state.bag.reduce((n, l) => n + l.qty, 0);
  const badge = document.getElementById('cart-count')!;
  if (badge.textContent !== String(count)) badge.textContent = String(count);
}

/** A line's total. `display` false is the catalog price the store charges and reports in its events. */
function lineTotal(l: Line, display = true): number {
  // BUG ghost_line: a line left in the bag at quantity 0 by Remove is shown and charged at ₹0 (price x 0), so every
  // total agrees with the shown lines and no built-in rule fires.
  const base = productById(l.id)!.price_minor * l.qty;
  // BUG qty_price: with quantity 2+, the bag shows that line in paise as if they were rupees (100x). The bag's
  // own sums use the shown values, so every total agrees with the others and no built-in rule fires.
  return display && bugs.has('qty_price') && l.qty >= 2 ? base * 100 : base;
}

/** The bag's totals as shown (`display` true), or as charged. */
function totals(display = true): { subtotal: number; discount: number; total: number } {
  const subtotal = state.bag.reduce((sum, l) => sum + lineTotal(l, display), 0);
  const discount = Math.round((subtotal * state.discountPct) / 100);
  const units = state.bag.reduce((n, l) => n + l.qty, 0);
  const last = state.bag[state.bag.length - 1];
  if (bugs.has('cart_total') && state.discountPct > 0 && units >= 2 && last) {
    // BUG cart_total: with a discount and 2+ items in the bag, the last item is left out of the total.
    const wrongSubtotal = subtotal - productById(last.id)!.price_minor;
    return { subtotal, discount, total: wrongSubtotal - Math.round((wrongSubtotal * state.discountPct) / 100) };
  }
  return { subtotal, discount, total: subtotal - discount };
}

const api = (path: string, body: unknown) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-bugs': [...bugs].join(',') }, body: JSON.stringify(body) });
const apiGet = (path: string) => fetch(path, { headers: { 'x-demo-bugs': [...bugs].join(',') }, cache: 'no-store' });

/** What checkout charges: the bag total plus delivery (free, unless shipping_shock is on). */
function checkoutDelivery(): number {
  return bugs.has('shipping_shock') ? SHOCK_DELIVERY_MINOR : 0;
}

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

const app = document.getElementById('app')!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function priceHtml(p: Product): string {
  if (!p.compare_minor) return money(p.price_minor);
  const off = Math.round((1 - p.price_minor / p.compare_minor) * 100);
  return `${money(p.price_minor)}<s>${money(p.compare_minor)}</s><span class="off">${off}% off</span>`;
}

function card(p: Product): string {
  const fav = state.favourites.has(p.id);
  return `<article class="card">
    <a href="/product/${p.id}" data-link class="card-media" data-testid="product-${p.id}" aria-label="${esc(p.name)}">${shoeSvg(p.colorway, { label: p.name })}</a>
    <button type="button" class="fav-btn ${fav ? 'on' : ''}" data-action="fav" data-id="${p.id}" aria-pressed="${fav}" aria-label="Favourite ${esc(p.name)}">${fav ? icons.heartFilled : icons.heart}</button>
    <div class="card-body">
      ${p.badge ? `<p class="badge">${p.badge}</p>` : ''}
      <a href="/product/${p.id}" data-link class="card-title">${esc(p.name)}</a>
      <p class="muted">${esc(p.kind)}</p>
      <p class="muted">${p.colours} Colour${p.colours > 1 ? 's' : ''}</p>
      <p class="price">${priceHtml(p)}</p>
    </div>
  </article>`;
}

function sorted(list: Product[]): Product[] {
  if (state.sort === 'price-asc') return [...list].sort((a, b) => a.price_minor - b.price_minor);
  if (state.sort === 'price-desc') return [...list].sort((a, b) => b.price_minor - a.price_minor);
  return list;
}

function matchesQuery(p: Product): boolean {
  const q = state.query.trim().toLowerCase();
  return !q || `${p.name} ${p.kind} ${p.category}`.toLowerCase().includes(q);
}

// ---------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------

function renderHome(): void {
  const hero = productById('pace-racer')!;
  const tiles: [string, string, Product][] = [
    ['Running', '/running', productById('velocity-runner')!],
    ['Lifestyle', '/men', productById('street-mid')!],
    ['Training', '/women', productById('studio-trainer')!],
  ];
  const trending = PRODUCTS.filter(matchesQuery);
  app.innerHTML = `
    <section class="hero">
      <a href="/product/${hero.id}" data-link class="hero-media" aria-label="${esc(hero.name)}">${shoeSvg(hero.colorway, { view: 'tilt', label: hero.name })}</a>
      <div class="hero-copy">
        <p class="eyebrow">${esc(hero.name)}</p>
        <h1 class="display">Built for your<br />fastest day</h1>
        <p class="lede">Our lightest racer yet: a full-length plate and a high-rebound foam stack, with nothing you don't need on race day.</p>
        <div class="hero-ctas">
          <a href="/product/${hero.id}" data-link class="pill dark">Shop</a>
          <a href="/running" data-link class="pill light">Explore Running</a>
        </div>
      </div>
    </section>
    <section class="section">
      <div class="section-head"><h2>Trending This Week</h2><a href="/men" data-link>Shop All</a></div>
      <div class="grid" id="grid" style="padding:0">${trending.map(card).join('') || '<p class="muted">No matches.</p>'}</div>
    </section>
    <section class="section">
      <div class="section-head"><h2>Shop by Sport</h2></div>
      <div class="tiles">
        ${tiles
          .map(
            ([label, path, p]) => `<a href="${path}" data-link class="tile">
              ${shoeSvg(p.colorway, { label: p.name })}
              <div class="tile-label"><span>${label}</span><span class="pill light">Shop</span></div>
            </a>`,
          )
          .join('')}
      </div>
    </section>`;
}

function renderListing(cat: (typeof CATEGORIES)[number]): void {
  const list = sorted(PRODUCTS.filter(cat.filter).filter(matchesQuery));
  app.innerHTML = `
    <div class="listing-head">
      <h1>${esc(cat.title)} (${list.length})</h1>
      <label class="sort">Sort By
        <select id="sort">
          <option value="featured" ${state.sort === 'featured' ? 'selected' : ''}>Featured</option>
          <option value="price-desc" ${state.sort === 'price-desc' ? 'selected' : ''}>Price: High-Low</option>
          <option value="price-asc" ${state.sort === 'price-asc' ? 'selected' : ''}>Price: Low-High</option>
        </select>
      </label>
    </div>
    <div class="grid" id="grid">${list.map(card).join('') || '<p class="muted">No matches.</p>'}</div>`;
}

function galleryMain(p: Product): string {
  return shoeSvg(p.colorway, { view: state.view, label: p.name });
}

function renderProduct(p: Product): void {
  state.selectedSize = null;
  state.view = 'side';
  state.sizeAttempts = 0;
  const fav = state.favourites.has(p.id);
  const views = ['side', 'mirror', 'tilt', 'detail'] as const;
  app.innerHTML = `
    <div class="pdp">
      <div class="gallery">
        <div class="thumbs">
          ${views
            .map(
              (v) =>
                `<button type="button" class="thumb ${v === 'side' ? 'on' : ''}" data-action="view" data-view="${v}" aria-label="${v} view">${shoeSvg(p.colorway, { view: v })}</button>`,
            )
            .join('')}
        </div>
        <div class="gallery-main" id="gallery-main">${galleryMain(p)}</div>
      </div>
      <section class="buy" data-product="${p.id}">
        ${p.badge ? `<p class="badge" style="margin:0">${p.badge}</p>` : ''}
        <h1>${esc(p.name)}</h1>
        <p class="kind">${esc(p.kind)}</p>
        <p class="pdp-price price">${priceHtml(p)}</p>
        <p class="eta" id="delivery-eta">Arrives in ${deliveryWindow()} business days</p>
        <div class="size-head"><span>Select Size</span><span class="muted">UK sizing</span></div>
        <div class="sizes" id="sizes">
          ${SIZES.map((s) => {
            const n = s.replace('UK ', '');
            const out = p.soldOut.includes(s);
            return `<button type="button" class="size" data-action="size" data-size="${s}" data-testid="size-${n}" ${out ? 'disabled aria-label="' + s + ' sold out"' : ''}>${s}</button>`;
          }).join('')}
        </div>
        <p class="size-error" id="size-error" hidden>Please select a size.</p>
        <div class="buy-actions">
          <button type="button" id="add-to-bag" class="pill dark block" data-testid="add-to-bag" disabled>Checking stock…</button>
          <button type="button" class="pill outline block" data-action="fav" data-id="${p.id}" aria-pressed="${fav}">${fav ? 'Favourited' : 'Favourite'} ${fav ? icons.heartFilled : icons.heart}</button>
        </div>
        <p class="desc">${esc(p.description)}</p>
        <ul class="specs">
          <li>Colour shown: ${p.colours > 1 ? 'Core colourway' : 'Single colourway'}</li>
          <li>Style: STR-${p.id.toUpperCase().slice(0, 6)}</li>
        </ul>
        <details class="acc"><summary>Free Delivery and Returns</summary><p>Free standard delivery on every order. Returns are free within 30 days. (This is a demo: nothing ships.)</p></details>
        <details class="acc"><summary>Reviews (128)</summary><p>★★★★☆ 4.4 average. "Comfortable from day one." Reviews are synthetic.</p></details>
        <button type="button" id="returns-info" class="link-btn">Returns policy</button>
        <div class="returns-panel" id="returns-panel" hidden>
          <p><strong>Free 30-day returns.</strong> Start a return from your order page; we email a prepaid label and refund within 5 days of receiving the pair. (Synthetic policy: nothing ships.)</p>
        </div>
      </section>
    </div>`;
  void checkStock(p.id);
}

/** Add to Bag waits for the stock check (BUG slow_stock: 4 s instead of 150 ms). Only the latest page's answer counts. */
let stockSeq = 0;
async function checkStock(id: string): Promise<void> {
  const mine = ++stockSeq;
  try {
    await apiGet(`/api/stock?product=${encodeURIComponent(id)}`);
  } catch {
    // The store backend is down: let the shopper try anyway.
  }
  const button = document.getElementById('add-to-bag') as HTMLButtonElement | null;
  if (mine !== stockSeq || !button || document.querySelector<HTMLElement>('.buy')?.dataset.product !== id) return;
  button.disabled = false;
  button.textContent = 'Add to Bag';
}

function toggleReturns(): void {
  // BUG returns_hidden: the Returns policy button silently does nothing.
  if (bugs.has('returns_hidden')) return;
  const panel = document.getElementById('returns-panel');
  if (panel) panel.hidden = !panel.hidden;
}

/** Up to three shoes for "Picked for you" on the bag page: ones not already in the bag. */
function recommendations(): Product[] {
  const inBag = new Set(state.bag.map((l) => l.id));
  return PRODUCTS.filter((p) => !inBag.has(p.id)).slice(0, 3);
}

function recsHtml(): string {
  const recs = recommendations();
  if (recs.length === 0) return '';
  // BUG recs_sold_out: the picks are shoes that have sold out, and Quick add does nothing.
  const soldOut = bugs.has('recs_sold_out');
  return `<section class="recs">
      <h2 class="section-title">Picked for you</h2>
      <div class="rec-grid">
        ${recs
          .map(
            (p) => `<div class="rec-card">
              <a href="/product/${p.id}" data-link class="bag-thumb">${shoeSvg(p.colorway, { label: p.name })}</a>
              <div><p>${esc(p.name)}</p><p class="muted">${soldOut ? 'Only a few left' : esc(p.kind)}</p><p>${money(p.price_minor)}</p></div>
              <button type="button" class="pill outline rec-add" data-testid="rec-add" data-id="${p.id}">Quick add</button>
            </div>`,
          )
          .join('')}
      </div>
    </section>`;
}

function quickAdd(id: string): void {
  if (bugs.has('recs_sold_out')) return;
  const p = productById(id);
  if (!p) return;
  const line = state.bag.find((l) => l.id === id && l.size === QUICK_ADD_SIZE);
  if (line) line.qty += 1;
  else state.bag.push({ id, size: QUICK_ADD_SIZE, qty: 1 });
  persist();
  renderBag();
}

function bagLines(): string {
  return state.bag
    .map((l) => {
      const p = productById(l.id)!;
      return `<div class="bag-line">
        <a href="/product/${p.id}" data-link class="bag-thumb">${shoeSvg(p.colorway, { label: p.name })}</a>
        <div class="bag-info">
          <div class="bag-row"><a href="/product/${p.id}" data-link>${esc(p.name)}</a><span data-cp-probe="line_total">${money(lineTotal(l))}</span></div>
          <p class="muted">${esc(p.kind)}</p>
          <p class="muted">Size ${l.size}</p>
          <div class="qty">
            <button type="button" data-action="dec" data-testid="qty-dec" data-key="${lineKey(l)}" aria-label="${l.qty <= 1 ? 'Remove' : 'Decrease quantity'}">${l.qty <= 1 ? icons.trash : icons.minus}</button>
            <span data-cp-probe="qty">${l.qty}</span>
            <button type="button" data-action="inc" data-testid="qty-inc" data-key="${lineKey(l)}" aria-label="Increase quantity">${icons.plus}</button>
          </div>
        </div>
      </div>`;
    })
    .join('');
}

function updateTotals(): void {
  const t = totals();
  document.getElementById('subtotal')!.textContent = money(t.subtotal);
  // The probe reads the amount only; the minus sign is presentation and sits outside it.
  document.getElementById('discount-sign')!.textContent = t.discount > 0 ? '-' : '';
  document.getElementById('discount')!.textContent = money(t.discount);
  document.getElementById('cart-total')!.textContent = money(t.total);
}

function renderBag(): void {
  if (state.bag.length === 0) {
    app.innerHTML = `<div class="empty"><h1>There are no items in your bag.</h1><a href="/" data-link class="pill dark">Shop New &amp; Featured</a></div>`;
    return;
  }
  app.innerHTML = `
    <div class="bag">
      <section>
        <h1 class="page-title">Bag</h1>
        <div id="cart-rows">${bagLines()}</div>
        ${recsHtml()}
      </section>
      <aside class="summary">
        <h2>Summary</h2>
        <div class="promo-box">
          <p>Do you have a promo code?</p>
          <div class="promo-row">
            <input id="coupon-code" name="coupon" placeholder="Promo code" autocomplete="off" />
            <button id="apply-coupon" type="button" class="pill outline"><span class="label">Apply Coupon</span></button>
          </div>
          <p id="coupon-msg" class="coupon-msg"></p>
        </div>
        <div class="sum-row"><span>Subtotal</span><span id="subtotal"></span></div>
        <div class="sum-row"><span>Discount</span><span><span id="discount-sign"></span><span id="discount" data-cp-probe="discount"></span></span></div>
        <div class="sum-row"><span>Estimated Delivery &amp; Handling</span><span>Free</span></div>
        <div class="sum-row total"><span>Total</span><span id="cart-total" data-cp-probe="cart_total"></span></div>
        <button id="checkout" type="button" class="pill dark block">Checkout</button>
      </aside>
    </div>`;
  updateTotals();
  cp.track('cart_viewed', { value_minor: totals(false).total, currency: 'INR' });
}

async function applyCoupon(): Promise<void> {
  state.couponClicks += 1;
  // BUG dead_button: after the third click the handler silently does nothing (no request, no DOM change).
  if (bugs.has('dead_button') && state.couponClicks > 3) return;

  const input = document.getElementById('coupon-code') as HTMLInputElement;
  const msg = document.getElementById('coupon-msg')!;
  const code = input.value.trim();
  msg.className = 'coupon-msg';
  if (!code) {
    msg.textContent = 'Enter a promo code.';
    msg.className = 'coupon-msg err';
    return;
  }
  msg.textContent = 'Checking…';
  const data = (await (await api('/api/coupon', { code })).json()) as { ok: boolean; percent?: number };
  if (data.ok) {
    state.discountPct = data.percent ?? 0;
    persist();
    msg.textContent = `${code.toUpperCase()} applied: ${state.discountPct}% off`;
    msg.className = 'coupon-msg ok';
    updateTotals();
  } else {
    msg.textContent = "That code isn't valid.";
    msg.className = 'coupon-msg err';
  }
}

const field = (id: string, label: string, attrs = '') =>
  `<div class="field"><input id="${id}" name="${id}" placeholder=" " ${attrs} /><label for="${id}">${label}</label></div>`;

function renderCheckout(): void {
  if (state.bag.length === 0) return navigate('/cart');
  const t = totals();
  const delivery = checkoutDelivery();
  state.authAttempts = 0;
  app.innerHTML = `
    <div class="checkout-page">
      <form class="checkout-form" id="checkout-form" novalidate>
        <h1 class="page-title">Checkout</h1>
        <h2 class="section-title">Delivery</h2>
        ${field('name', 'Full name', 'autocomplete="name"')}
        ${field('email', 'Email', 'type="email" autocomplete="email"')}
        ${field('phone', 'Phone number', 'type="tel" autocomplete="tel"')}
        <div class="field">
          <select id="region" name="region"><option>North</option><option>South</option><option>East</option><option>West</option><option>Northeast</option></select>
          <label for="region">Region</label>
        </div>
        <div class="full">${field('address', 'Address', 'autocomplete="street-address"')}</div>
        <h2 class="section-title">Payment</h2>
        <div class="payment" data-cp-block>
          ${field('card', 'Card number', 'name="cardnumber" autocomplete="cc-number" inputmode="numeric"')}
          ${field('exp', 'MM/YY', 'autocomplete="cc-exp"')}
          ${field('cvv', 'CVV', 'autocomplete="cc-csc"')}
        </div>
        <p class="error-box" id="checkout-error"></p>
        <button id="retry-card" type="button" class="pill outline block" hidden>Use another card</button>
        <button id="place-order" type="submit" class="pill dark block">Place Order</button>
        <p class="fine">This is a synthetic demo store. Nothing is charged or shipped.</p>
      </form>
      <aside class="summary">
        <h2>In Your Bag</h2>
        ${state.bag
          .map((l) => {
            const p = productById(l.id)!;
            return `<div class="mini-line"><div class="bag-thumb">${shoeSvg(p.colorway, { label: p.name })}</div><div><p>${esc(p.name)}</p><p class="muted">Size ${l.size} · Qty ${l.qty}</p><p>${money(lineTotal(l))}</p></div></div>`;
          })
          .join('')}
        <div class="sum-row"><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
        <div class="sum-row"><span>Discount</span><span>${t.discount > 0 ? `-${money(t.discount)}` : money(0)}</span></div>
        <div class="sum-row"><span>Delivery &amp; handling</span><span id="delivery-fee">${delivery > 0 ? money(delivery) : 'Free'}</span></div>
        <div class="sum-row total"><span>Total</span><span>${money(t.total + delivery)}</span></div>
        <div class="help-box">
          <p>Questions about your order?</p>
          <button id="chat-help" type="button" class="pill outline">Chat with us</button>
          <p id="chat-msg" class="chat-msg"></p>
        </div>
      </aside>
    </div>`;
}

async function startChat(): Promise<void> {
  const msg = document.getElementById('chat-msg');
  const res = await api('/api/support/session', {});
  // BUG support_down: the chat cannot start (503) and the widget throws, so the shopper sees nothing happen.
  if (!res.ok) throw new Error('support chat unavailable');
  const data = (await res.json()) as { agent?: string; wait_minutes?: number };
  if (msg) msg.textContent = `${data.agent ?? 'Support'} will reply in about ${data.wait_minutes ?? 2} minutes.`;
}

function useAnotherCard(): void {
  // BUG card_declined: after the decline, Use another card silently does nothing.
  if (bugs.has('card_declined')) return;
  document.getElementById('retry-card')!.hidden = true;
  document.getElementById('checkout-error')!.textContent = 'Enter another card, then place your order again.';
}

async function placeOrder(form: HTMLFormElement): Promise<void> {
  const button = document.getElementById('place-order') as HTMLButtonElement;
  const errorBox = document.getElementById('checkout-error')!;
  const region = (form.elements.namedItem('region') as HTMLSelectElement).value;
  const retry = document.getElementById('retry-card')!;
  button.disabled = true;
  button.textContent = 'Contacting your bank…';
  errorBox.textContent = '';
  retry.hidden = true;
  // The bank authorises first (BUG card_declined: always declined; BUG slow_payment: the first try hangs 6.5 s).
  state.authAttempts += 1;
  const auth = (await (await api('/api/payment/authorize', { total_minor: totals(false).total + checkoutDelivery(), attempt: state.authAttempts })).json()) as { ok: boolean; reason?: string };
  if (!auth.ok) {
    button.disabled = false;
    button.textContent = 'Place Order';
    if (auth.reason === 'card_declined') {
      errorBox.textContent = 'Your card was declined by your bank.';
      retry.hidden = false;
    } else {
      errorBox.textContent = 'Your bank took too long to respond. Please try again.';
    }
    return;
  }
  button.textContent = 'Placing Order…';
  const res = await api('/api/checkout', { region, total_minor: totals(false).total });
  if (!res.ok) {
    errorBox.textContent = "We couldn't process your payment. Please try again.";
    button.disabled = false;
    button.textContent = 'Place Order';
    // BUG checkout_error: the payment step also throws, surfacing as an unhandled rejection.
    if (bugs.has('checkout_error')) throw new TypeError('payment gateway unavailable');
    return;
  }
  const { order_id } = (await res.json()) as { order_id: string };
  cp.track('order_placed', { value_minor: totals(false).total, currency: 'INR' });
  state.bag = [];
  state.discountPct = 0;
  persist();
  navigate(`/order/${order_id}`);
}

function renderOrder(orderId: string): void {
  app.innerHTML = `
    <div class="order">
      <h1 class="display">Thanks, you're all set</h1>
      <p data-cp-mask>Order ${esc(orderId)} is confirmed. A receipt is on its way to your inbox.</p>
      <p class="muted">Synthetic order: nothing will ship.</p><br />
      <a href="/" data-link class="pill dark">Continue Shopping</a>
    </div>`;
}

function renderFavourites(): void {
  const list = PRODUCTS.filter((p) => state.favourites.has(p.id));
  app.innerHTML = list.length
    ? `<div class="listing-head"><h1>Favourites (${list.length})</h1></div><div class="grid" id="grid">${list.map(card).join('')}</div>`
    : `<div class="empty"><h1>Items added to your Favourites will be saved here.</h1><a href="/" data-link class="pill dark">Shop New &amp; Featured</a></div>`;
}

function renderHelp(): void {
  app.innerHTML = `
    <article class="content">
      <h1>About this demo store</h1>
      <p>${BRAND} is a fictional brand. This store exists so Churn Preventer can record and analyse realistic but <strong>synthetic</strong> shopping sessions. Nothing is sold or shipped.</p>
      <h2>Where do I see the replay of my session?</h2>
      <p>Open <strong>Demo controls</strong> (bottom left) and press <strong>Watch this session's replay</strong>. Flagged sessions are also listed on the <a class="underline" href="${DASHBOARD_URL}" target="_blank" rel="noopener">dashboard</a>. Replays update about every 5 seconds as your session uploads.</p>
      <h2>Trying the bugs</h2>
      <p>Switch them on in the dashboard (localhost:5174, top bar), or open the store with <code>?bugs=dead_button</code>.</p>
      <ul>
        <li><strong>dead_button</strong>: in your Bag, type SAVE10 and press Apply Coupon 4+ times, about a second apart. From the 4th press it silently does nothing; those presses are flagged as dead clicks.</li>
        <li><strong>cart_total</strong>: put 2 or more items in the bag (2 of one shoe, or two different shoes), apply SAVE10, and the total leaves out the last item.</li>
        <li><strong>checkout_error</strong>: choose region Northeast at checkout and Place Order fails.</li>
        <li><strong>ghost_line</strong>: put two shoes in your Bag and press Remove (the bin) on one. It stays in the bag at quantity 0 (₹0), and pressing Remove again does nothing. The totals agree with the lines, so no built-in rule fires: the agent suggests one on the dashboard's Rules tab.</li>
        <li><strong>qty_price</strong>: press + on a bag line; at quantity 2 it shows 100x its price.</li>
        <li><strong>slow_stock</strong>: open any shoe; Add to Bag waits 4 seconds on a stock check.</li>
        <li><strong>shipping_shock</strong>: the bag says delivery is free; checkout adds ₹499 delivery and handling.</li>
        <li><strong>slow_delivery</strong>: product pages promise delivery in 9–12 days.</li>
        <li><strong>returns_hidden</strong>: on a product page, Returns policy does nothing.</li>
        <li><strong>support_down</strong>: at checkout, Chat with us fails.</li>
        <li><strong>recs_sold_out</strong>: in your Bag, Quick add under Picked for you does nothing.</li>
        <li><strong>card_declined</strong>: Place Order: the card is declined, and Use another card does nothing.</li>
        <li><strong>slow_payment</strong>: Place Order waits 6.5 seconds, then the bank times out (a second try works).</li>
      </ul>
      <p>The agent finds the slow, shipping and delivery bugs on its own: watch the Rules tab for "The agent suspects".</p>
      <h2>Privacy</h2>
      <p>Recording starts only after you accept. Everything you type is masked before it leaves the browser, and payment fields are never captured.</p>
      <p><a href="/" data-link class="pill dark">Back to the store</a></p>
    </article>`;
}

function renderNotFound(): void {
  app.innerHTML = `<div class="empty"><h1>We can't find the page you're looking for.</h1><a href="/" data-link class="pill dark">Home</a></div>`;
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

function render(): void {
  const path = location.pathname;
  hideToast();
  const cat = CATEGORIES.find((c) => c.path === path && c.path !== '/');
  if (path === '/') renderHome();
  else if (cat) renderListing(cat);
  else if (path.startsWith('/product/')) {
    const p = productById(decodeURIComponent(path.slice('/product/'.length)));
    if (p) renderProduct(p);
    else renderNotFound();
  } else if (path === '/cart') renderBag();
  else if (path === '/checkout') renderCheckout();
  else if (path.startsWith('/order/')) renderOrder(decodeURIComponent(path.slice('/order/'.length)));
  else if (path === '/favourites') renderFavourites();
  else if (path === '/help') renderHelp();
  else renderNotFound();

  for (const a of document.querySelectorAll<HTMLAnchorElement>('#main-nav a')) a.classList.toggle('active', a.getAttribute('href') === path);
  persist();
}

function navigate(path: string): void {
  if (location.pathname === path) {
    render();
  } else {
    history.pushState({}, '', path);
    render();
  }
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------------------------
// Bag, favourites, toast
// ---------------------------------------------------------------------------------------------

const toast = document.getElementById('toast')!;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function hideToast(): void {
  clearTimeout(toastTimer);
  if (!toast.hidden) toast.hidden = true;
}

function showToast(p: Product, size: string): void {
  const count = state.bag.reduce((n, l) => n + l.qty, 0);
  toast.innerHTML = `
    <div class="toast-head"><span>${icons.check} Added to Bag</span><button type="button" class="toast-close" data-action="close-toast" data-testid="toast-close" aria-label="Close">${icons.close}</button></div>
    <div class="toast-item"><div class="bag-thumb">${shoeSvg(p.colorway, { label: p.name })}</div><div><p><strong>${esc(p.name)}</strong></p><p class="muted">${esc(p.kind)}</p><p class="muted">Size ${size}</p><p>${money(p.price_minor)}</p></div></div>
    <div class="toast-actions"><a href="/cart" data-link class="pill light" data-testid="toast-view-bag">View Bag (${count})</a><a href="/checkout" data-link class="pill dark">Checkout</a></div>`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 6000);
}

function addToBag(): void {
  const id = document.querySelector<HTMLElement>('.buy')?.dataset.product;
  const p = id ? productById(id) : undefined;
  if (!p) return;
  const sizes = document.getElementById('sizes')!;
  const error = document.getElementById('size-error')!;
  if (!state.selectedSize) {
    // Always a visible change, even on a repeat attempt.
    state.sizeAttempts += 1;
    sizes.classList.add('invalid');
    sizes.dataset.attempt = String(state.sizeAttempts);
    error.hidden = false;
    return;
  }
  const line = state.bag.find((l) => l.id === p.id && l.size === state.selectedSize);
  if (line) line.qty += 1;
  else state.bag.push({ id: p.id, size: state.selectedSize, qty: 1 });
  persist();
  showToast(p, state.selectedSize);
}

function toggleFavourite(id: string): void {
  if (state.favourites.has(id)) state.favourites.delete(id);
  else state.favourites.add(id);
  persist();
  const on = state.favourites.has(id);
  for (const btn of document.querySelectorAll<HTMLButtonElement>(`[data-action="fav"][data-id="${id}"]`)) {
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('on', on);
    btn.innerHTML = btn.classList.contains('fav-btn') ? (on ? icons.heartFilled : icons.heart) : `${on ? 'Favourited' : 'Favourite'} ${on ? icons.heartFilled : icons.heart}`;
  }
  if (location.pathname === '/favourites') renderFavourites();
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

document.addEventListener('click', (e) => {
  const target = e.target as Element;
  if (target.closest('.demo-dock')) return;

  const link = target.closest<HTMLAnchorElement>('a[data-link]');
  if (link) {
    e.preventDefault();
    navigate(link.getAttribute('href') ?? '/');
    return;
  }
  if (target.closest('#apply-coupon')) return void applyCoupon();
  if (target.closest('#add-to-bag')) return addToBag();
  if (target.closest('#returns-info')) return toggleReturns();
  if (target.closest('#chat-help')) return void startChat();
  if (target.closest('#retry-card')) return useAnotherCard();
  const rec = target.closest<HTMLElement>('.rec-add');
  if (rec) return quickAdd(rec.dataset.id ?? '');
  if (target.closest('#checkout')) {
    cp.track('checkout_started', { value_minor: totals(false).total, currency: 'INR' });
    return navigate('/checkout');
  }

  const action = target.closest<HTMLElement>('[data-action]');
  if (!action) return;
  switch (action.dataset.action) {
    case 'fav':
      return toggleFavourite(action.dataset.id ?? '');
    case 'close-toast':
      return hideToast();
    case 'size': {
      const size = action.dataset.size ?? '';
      // A second press deselects, so every press visibly changes the grid.
      state.selectedSize = state.selectedSize === size ? null : size;
      for (const b of document.querySelectorAll<HTMLElement>('.size')) b.classList.toggle('selected', b.dataset.size === state.selectedSize);
      if (state.selectedSize) {
        document.getElementById('sizes')!.classList.remove('invalid');
        document.getElementById('size-error')!.hidden = true;
      }
      return;
    }
    case 'view': {
      const p = productById(document.querySelector<HTMLElement>('.buy')?.dataset.product ?? '');
      if (!p) return;
      state.view = (action.dataset.view as typeof state.view) ?? 'side';
      for (const t of document.querySelectorAll<HTMLElement>('.thumb')) t.classList.toggle('on', t === action);
      document.getElementById('gallery-main')!.innerHTML = galleryMain(p);
      return;
    }
    case 'inc':
    case 'dec': {
      const line = state.bag.find((l) => lineKey(l) === action.dataset.key);
      if (!line) return;
      const dec = action.dataset.action === 'dec';
      // BUG ghost_line: Remove on a line already at 0 silently does nothing (no request, no DOM change)...
      if (bugs.has('ghost_line') && dec && line.qty === 0) return;
      line.qty += dec ? -1 : 1;
      // ...and Remove at quantity 1 leaves the line in the bag at 0 (re-rendered below, so this press visibly responds).
      if (line.qty <= 0 && !bugs.has('ghost_line')) state.bag = state.bag.filter((l) => l !== line);
      persist();
      if (state.bag.length === 0) renderBag();
      else {
        document.getElementById('cart-rows')!.innerHTML = bagLines();
        updateTotals();
      }
      return;
    }
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target as HTMLFormElement;
  if (form.id !== 'checkout-form') return;
  e.preventDefault();
  void placeOrder(form);
});

document.addEventListener('change', (e) => {
  const el = e.target as HTMLElement;
  if (el.id === 'sort') {
    state.sort = (el as HTMLSelectElement).value as typeof state.sort;
    render();
  }
});

const search = document.getElementById('search') as HTMLInputElement;
search.addEventListener('input', () => {
  state.query = search.value;
  const onListing = location.pathname === '/' || CATEGORIES.some((c) => c.path === location.pathname);
  if (onListing) render();
});
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigate(CATEGORIES.some((c) => c.path === location.pathname) ? location.pathname : '/men');
});

window.addEventListener('popstate', render);

// ---------------------------------------------------------------------------------------------
// Consent banner and the Demo controls dock (tester tooling, excluded from recording)
// ---------------------------------------------------------------------------------------------

document.getElementById('search-icon')!.innerHTML = icons.search;
document.getElementById('nav-fav')!.innerHTML = icons.heart;
document.getElementById('bag-icon')!.innerHTML = icons.bag;

const consent = document.getElementById('consent')!;
const demoToggle = document.getElementById('demo-toggle')!;
const demoPanel = document.getElementById('demo-panel')!;

function grantConsent(): void {
  localStorage.setItem('cp_consent', 'granted');
  cp.grantConsent();
  consent.hidden = true;
  refreshDemoPanel();
}

function refreshDemoPanel(): void {
  const el = document.getElementById('session-link')!;
  demoToggle.classList.toggle('off', !cp.sessionId);
  el.innerHTML = cp.sessionId
    ? `<p>Recording session<br /><b>${cp.sessionId}</b></p>
       <a class="pill dark" href="${DASHBOARD_URL}/#/sessions/${cp.sessionId}" target="_blank" rel="noopener">${icons.play} Watch this session's replay</a>
       <div class="links"><a href="${DASHBOARD_URL}" target="_blank" rel="noopener">All flagged sessions ↗</a><a href="/help" data-link>How this works</a></div>`
    : `<p>Not recording: consent not given.</p><button type="button" class="pill dark" id="demo-record">Record this session</button>`;
}

consent.hidden = Boolean(localStorage.getItem('cp_consent'));
document.getElementById('consent-accept')!.addEventListener('click', grantConsent);
document.getElementById('consent-decline')!.addEventListener('click', () => {
  localStorage.setItem('cp_consent', 'declined');
  consent.hidden = true;
  refreshDemoPanel();
});

demoToggle.addEventListener('click', () => {
  demoPanel.hidden = !demoPanel.hidden;
});
demoPanel.addEventListener('click', (e) => {
  const t = e.target as Element;
  if (t.closest('#demo-record')) grantConsent();
  const link = t.closest<HTMLAnchorElement>('a[data-link]');
  if (link) {
    e.preventDefault();
    navigate(link.getAttribute('href') ?? '/');
  }
});
render();
refreshDemoPanel();
