/* Records the screen clips for the demo video, one per scene, plus a log of where each interaction happened so the
 * Remotion composition can zoom to those exact elements. Also pulls the live numbers the animated scenes use.
 *   node scripts/capture.cjs        (needs ffmpeg on PATH or FFMPEG set; Playwright from the repo)
 * All data on screen is synthetic.
 */
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const req = createRequire('D:/gemai-defcon1/package.json');
const { chromium } = req('playwright');

const API = process.env.API || 'https://cp-api-w46tbwzpaq-el.a.run.app';
const SHOP = process.env.SHOP || 'https://cp-shop-w46tbwzpaq-el.a.run.app';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const W = 1440;
const H = 810;
const pub = path.join(__dirname, '..', 'public');
const raw = path.join(__dirname, '..', '.raw');
fs.mkdirSync(path.join(pub, 'clips'), { recursive: true });
fs.mkdirSync(raw, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => process.stdout.write(`${s}\n`);

const cursorJs = () => {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;z-index:2147483647;width:26px;height:26px;border-radius:50%;background:rgba(26,115,232,.30);border:3px solid #1a73e8;pointer-events:none;transform:translate(-50%,-50%);left:-60px;top:-60px';
  const add = () => document.documentElement.appendChild(d);
  if (document.documentElement) add();
  else document.addEventListener('DOMContentLoaded', add);
  document.addEventListener('mousemove', (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
  document.addEventListener('mousedown', () => { d.style.transform = 'translate(-50%,-50%) scale(.6)'; }, true);
  document.addEventListener('mouseup', () => { d.style.transform = 'translate(-50%,-50%) scale(1)'; }, true);
};

/** One clip: a fresh page, a video, and an event log (seconds from the start of the video). */
async function clip(browser, id, run) {
  const dir = path.join(raw, id);
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir, size: { width: W, height: H } } });
  await ctx.addInitScript(cursorJs);
  const page = await ctx.newPage();
  const t0 = Date.now();
  const events = [];
  let trim = 0;
  const now = () => (Date.now() - t0) / 1000;
  const api = {
    page,
    /** Everything before this call is cut from the final clip (setup). */
    start: () => { trim = now(); },
    /** Zoom the camera to an element for `hold` seconds. `click` draws a ripple at the element. */
    async focus(loc, { scale = 1.6, hold = 1.4, click = false, label } = {}) {
      const box = await loc.first().boundingBox();
      if (!box) return;
      events.push({ t: now(), x: box.x + box.width / 2, y: box.y + box.height / 2, w: box.width, h: box.height, scale, hold, click, label });
    },
    async glide(loc, steps = 14) {
      const box = await loc.first().boundingBox();
      if (!box) return;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
    },
    async click(loc, opts = {}) {
      await api.glide(loc, opts.steps ?? 12);
      await api.focus(loc, { ...opts, click: true });
      await sleep(opts.pause ?? 140);
      const box = await loc.first().boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    },
    async scroll(dy, ms = 700) {
      const steps = Math.max(4, Math.round(ms / 30));
      for (let i = 0; i < steps; i++) {
        await page.mouse.wheel(0, dy / steps);
        await sleep(ms / steps);
      }
    },
    sleep,
  };
  await run(api);
  const dur = now();
  const video = await page.video().path();
  await ctx.close();
  const out = path.join(pub, 'clips', `${id}.mp4`);
  const r = spawnSync(FFMPEG, ['-y', '-i', video, '-r', '30', '-c:v', 'libx264', '-crf', '17', '-pix_fmt', 'yuv420p', '-an', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr.slice(-400)}`);
  fs.writeFileSync(path.join(pub, 'clips', `${id}.json`), JSON.stringify({ id, trim, duration: dur, width: W, height: H, events }, null, 1));
  say(`clip ${id}: ${dur.toFixed(1)} s (setup ${trim.toFixed(1)} s), ${events.length} focus events`);
}

async function dismissAll(p) {
  const b = p.getByRole('button', { name: 'Dismiss' });
  for (let i = (await b.count()) - 1; i >= 0; i--) await b.nth(i).click({ timeout: 800 }).catch(() => {});
}

async function liveData() {
  const g = async (p) => (await fetch(`${API}${p}`)).json();
  const { findings } = await g('/v1/findings?limit=200');
  const tl = await g('/v1/history/timeline');
  const clean = (t) => t.replace(/ (on|at) \/[\w:/-]+$/, '').replace(/button#/g, 'button ');
  const open = findings.filter((f) => !(f.resolution && f.last_seen <= f.resolution.resolved_at) && f.revenue.status === 'ok');
  const top = [...open].sort((a, b) => b.revenue.revenue_at_risk_minor - a.revenue.revenue_at_risk_minor);
  const known = new Map(tl.findings.map((t) => [t.finding_id, t]));
  const lanes = top.slice(0, 8).map((f) => {
    const t = known.get(f.finding_id);
    return { title: clean(f.title), minor: f.revenue.revenue_at_risk_minor, hit: t?.first_hit ?? f.first_seen, known: t?.first_known ?? f.updated_at, tier: f.tier };
  });
  const data = {
    total_minor: open.reduce((n, f) => n + f.revenue.revenue_at_risk_minor, 0),
    issues: open.length,
    top: top.slice(0, 6).map((f) => ({ title: clean(f.title), minor: f.revenue.revenue_at_risk_minor, tier: f.tier, shoppers: f.affected_sessions })),
    lanes,
    top_id: top[0].cluster_id,
    replay: null,
  };
  const { finding } = await g(`/v1/findings/${top[0].cluster_id}`);
  const ev = (finding.evidence || []).find((e) => e.session_id && e.signal_id);
  if (ev) data.replay = { session: ev.session_id, signal: ev.signal_id };
  fs.writeFileSync(path.join(pub, 'data.json'), JSON.stringify(data, null, 1));
  say(`data: ${data.issues} issues, ₹${(data.total_minor / 1e7).toFixed(1)}L, top ${data.top[0].title}`);
  return data;
}

(async () => {
  const data = await liveData();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  await clip(browser, 'shop', async (c) => {
    const p = c.page;
    await p.goto(`${SHOP}/product/velocity-runner?bugs=checkout_error`, { waitUntil: 'domcontentloaded' });
    await p.evaluate(() => { try { localStorage.setItem('cp_consent', 'granted'); } catch {} });
    await p.waitForSelector('.size:not([disabled])', { timeout: 20000 });
    await p.locator('.size:not([disabled])').first().click();
    await p.waitForFunction(() => { const b = document.getElementById('add-to-bag'); return b && !b.disabled; }, null, { timeout: 20000 });
    await p.click('#add-to-bag');
    await sleep(500);
    await p.getByRole('button', { name: 'Accept' }).click({ timeout: 3000 }).catch(() => {});
    await p.click('[data-testid="nav-cart"]');
    await p.waitForSelector('#checkout');
    await p.click('#checkout');
    await p.waitForSelector('#checkout-form');
    await sleep(700);
    c.start();
    await sleep(600);
    const type = async (sel, text) => {
      await c.click(p.locator(sel), { scale: 1.35, hold: 1.0, pause: 60, steps: 8 });
      await p.keyboard.type(text, { delay: 22 });
    };
    await type('#name', 'Asha Rao');
    await type('#email', 'asha.rao@example.com');
    await type('#phone', '98765 43210');
    await type('#address', '12 MG Road, Bengaluru');
    await c.focus(p.locator('#region'), { scale: 1.6, hold: 1.0 });
    await c.glide(p.locator('#region'), 8);
    await p.selectOption('#region', 'Northeast');
    await sleep(400);
    await type('#card', '4111 1111 1111 1111');
    await p.keyboard.press('Tab');
    await p.keyboard.type('12/30', { delay: 22 });
    await p.keyboard.press('Tab');
    await p.keyboard.type('123', { delay: 22 });
    await sleep(500);
    await c.click(p.locator('#place-order'), { scale: 1.7, hold: 1.6, pause: 200 });
    await p.waitForFunction(() => (document.getElementById('checkout-error')?.textContent || '').length > 5, null, { timeout: 15000 }).catch(() => {});
    await sleep(600);
    await c.focus(p.locator('#checkout-error'), { scale: 1.9, hold: 1.8 });
    await sleep(1800);
    await c.click(p.locator('#place-order'), { scale: 1.7, hold: 1.2, pause: 160 });
    await sleep(2200);
  });

  await clip(browser, 'dashboard', async (c) => {
    const p = c.page;
    await p.goto(`${API}/?d=${Date.now()}#/`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('text=Fix these first', { timeout: 20000 });
    await sleep(2200);
    await dismissAll(p);
    c.start();
    await c.focus(p.getByText('Money your store is losing right now').first(), { scale: 1.7, hold: 2.0 });
    await sleep(2200);
    await c.scroll(300, 600);
    await c.focus(p.getByText('Money lost over time, by issue').first(), { scale: 1.45, hold: 2.4 });
    await c.glide(p.getByText('Money lost over time, by issue').first(), 12);
    await sleep(2600);
    await c.focus(p.getByText('Fix these first').first(), { scale: 1.7, hold: 2.6 });
    await c.glide(p.getByText('Fix these first').first(), 12);
    await sleep(2800);
  });

  await clip(browser, 'issue', async (c) => {
    const p = c.page;
    await p.goto(`${API}/?i=${Date.now()}#/issues/${data.top_id}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('text=Reviewed by', { timeout: 20000 });
    await dismissAll(p);
    await sleep(1200);
    c.start();
    await c.focus(p.getByRole('heading').first(), { scale: 1.6, hold: 1.8 });
    await sleep(1500);
    await c.focus(p.getByText('Revenue lost so far').first(), { scale: 2.0, hold: 1.6 });
    await c.glide(p.getByText('Revenue lost so far').first());
    await sleep(1500);
    await c.focus(p.getByText('How to reproduce').first(), { scale: 1.7, hold: 2.0 });
    await c.glide(p.getByText('How to reproduce').first());
    await sleep(2200);
    await c.click(p.getByRole('tab', { name: 'Proof' }).or(p.getByText('Proof', { exact: true })), { scale: 1.8, hold: 0.9 });
    await sleep(900);
    await c.focus(p.getByText('The flagged moment').first(), { scale: 1.35, hold: 2.6 });
    await sleep(2800);
    await c.click(p.getByRole('tab', { name: 'Summary' }).or(p.getByText('Summary', { exact: true })), { scale: 1.8, hold: 0.9 });
    await sleep(900);
    await c.focus(p.getByText('Reviewed by').first(), { scale: 1.9, hold: 2.2 });
    await c.glide(p.getByText('Reviewed by').first());
    await sleep(2400);
  });

  if (data.replay) {
    await clip(browser, 'replay', async (c) => {
      const p = c.page;
      await p.goto(`${API}/?p=${Date.now()}#/sessions/${data.replay.session}?signal=${data.replay.signal}`, { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('iframe', { timeout: 25000 }).catch(() => {});
      await dismissAll(p);
      await sleep(1500);
      await dismissAll(p);
      c.start();
      await sleep(900);
      const frame = p.locator('.rr-player, .replayer-wrapper, iframe').first();
      await c.focus(frame, { scale: 1.25, hold: 3.0 });
      await c.glide(frame, 12);
      await sleep(7000);
    });
  }

  await clip(browser, 'rules', async (c) => {
    const p = c.page;
    await p.goto(`${API}/?r=${Date.now()}#/rules`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('text=Suggested by the agent', { timeout: 20000 });
    await dismissAll(p);
    await sleep(900);
    c.start();
    await c.focus(p.getByText('Suggested by the agent').first(), { scale: 1.7, hold: 2.2 });
    await c.glide(p.getByText('Suggested by the agent').first());
    await sleep(2400);
    await c.click(p.getByRole('tab', { name: /Live rules/ }).first(), { scale: 1.9, hold: 1.2 });
    await sleep(2200);
  });

  await clip(browser, 'history', async (c) => {
    const p = c.page;
    await p.goto(`${API}/?h=${Date.now()}#/history`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('text=How long each problem went unnoticed', { timeout: 25000, state: 'attached' });
    await p.evaluate(() => window.scrollTo(0, 0));
    await dismissAll(p);
    await sleep(1500);
    c.start();
    await c.focus(p.getByText('How long each problem went unnoticed').first(), { scale: 1.6, hold: 2.0 });
    await sleep(1800);
    const stripe = p.locator('button[aria-label*="Payment authorization"]').first();
    await c.glide(stripe);
    await c.focus(stripe, { scale: 2.1, hold: 2.6 });
    await sleep(2800);
    await c.click(p.locator('button[aria-label*="Delivery fee"]').first(), { scale: 1.8, hold: 1.4 });
    await sleep(1800);
  });

  await browser.close();
  say('capture done');
})().catch((e) => { console.error(e); process.exit(1); });
