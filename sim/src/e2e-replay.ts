import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { arg, flushSdk, launchBrowser, moveAndClick, requireServices, say, sessionIdOf, typeInto, URLS, waitFor } from './browser.js';

/**
 * `pnpm e2e`: the replay check on a real browser (installed Chrome, throwaway profile).
 * A synthetic shopper uses the demo shop with the dead_button bug on, then the run asserts that:
 *   1. exactly two dead_click signals land on button#apply-coupon (clicks 4 and 5),
 *   2. the stitched replay has a full snapshot and both flags,
 *   3. nothing the shopper typed (name, email, phone, address, card) is in the stored session,
 *   4. the session joins exactly one issue (cluster), about that button,
 *   5. the dashboard replay outlines the flagged button and shows the caption (screenshots saved).
 * Needs `pnpm dev` running. All data is synthetic.
 *
 *   pnpm e2e [-- --headed] [--out <dir>] [--channel chrome|msedge]
 */

const SHOP = URLS.shop;
const API = URLS.api;
const DASHBOARD = URLS.dashboard;

const outDir = resolve(arg('out') ?? join('sim', 'out'));
const headed = process.argv.includes('--headed');
/** Installed browser to drive: chrome (default) or msedge. Both use a throwaway profile. */
const channel = arg('channel') ?? process.env.E2E_CHANNEL ?? 'chrome';

const failures: string[] = [];
function check(ok: boolean, what: string): void {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures.push(what);
}

/** The synthetic shopper's typed details. None of these may appear in stored data. */
const PII = {
  name: 'Asha Rao',
  email: 'asha.rao@example.com',
  phone: '+91 98765 43210',
  address: '12 MG Road, Bengaluru',
  card: '4111 1111 1111 1111',
};

interface SignalView {
  signal_id: string;
  detector: string;
  route: string;
  fingerprint: string;
  element_selector: string | null;
  event_time: number;
}

async function main(): Promise<void> {
  say('e2e: replay check on the demo shop (synthetic data)');
  await requireServices(['collector', 'api', 'shop', 'dashboard']);
  mkdirSync(outDir, { recursive: true });

  const browser = await launchBrowser(channel, headed);
  try {
    // ---- 1. A shopper hits the dead Apply Coupon button -------------------------------------
    const shop = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await shop.goto(`${SHOP}/?bugs=dead_button`);
    await moveAndClick(shop, '#consent-accept');
    const sessionId = await waitFor('the SDK to start', () => sessionIdOf(shop));
    say(`  session ${sessionId}`);

    // Browse like a shopper: product page, pick a size, add to bag (twice, two products).
    await moveAndClick(shop, '[data-testid="product-velocity-runner"]');
    await shop.waitForSelector('#add-to-bag');
    await moveAndClick(shop, '[data-testid="size-9"]');
    await moveAndClick(shop, '#add-to-bag');
    await shop.waitForSelector('[data-testid="toast-close"]');
    await moveAndClick(shop, '[data-testid="toast-close"]');
    await moveAndClick(shop, '[data-testid="nav-home"]');
    await moveAndClick(shop, '[data-testid="product-court-classic"]');
    await shop.waitForSelector('#add-to-bag');
    await moveAndClick(shop, '[data-testid="size-8"]');
    await moveAndClick(shop, '#add-to-bag');
    await moveAndClick(shop, '[data-testid="toast-view-bag"]');
    await shop.waitForSelector('#apply-coupon');
    await typeInto(shop, '#coupon-code', 'SAVE10');
    for (let i = 0; i < 5; i++) {
      await moveAndClick(shop, '#apply-coupon');
      await shop.waitForTimeout(1300);
    }
    await moveAndClick(shop, '#checkout');
    await shop.waitForSelector('#checkout-form');
    await typeInto(shop, '#name', PII.name);
    await typeInto(shop, '#email', PII.email);
    await typeInto(shop, '#phone', PII.phone);
    await typeInto(shop, '#address', PII.address);
    await typeInto(shop, '#card', PII.card);
    await shop.waitForTimeout(1000);
    await flushSdk(shop);
    await shop.close({ runBeforeUnload: true });

    // ---- 2. Signals and replay --------------------------------------------------------------
    say('checks');
    const dead = await waitFor('two dead_click signals', async () => {
      const body = (await (await fetch(`${API}/v1/signals?session=${sessionId}`)).json()) as { signals: SignalView[] };
      const d = body.signals.filter((s) => s.detector === 'dead_click');
      return d.length >= 2 ? d : null;
    });
    await new Promise((r) => setTimeout(r, 1500)); // let any late batch land before counting
    const all = ((await (await fetch(`${API}/v1/signals?session=${sessionId}`)).json()) as { signals: SignalView[] }).signals;
    check(all.filter((s) => s.detector === 'dead_click').length === 2, `exactly 2 dead_click signals (got ${all.length})`);
    check(dead.every((s) => s.element_selector === 'button#apply-coupon'), 'both on button#apply-coupon');
    check(dead.every((s) => s.route === '/cart'), `both on route /cart (got ${[...new Set(dead.map((s) => s.route))].join(', ')})`);
    check(new Set(dead.map((s) => s.fingerprint)).size === 1, 'both share one fingerprint (they will cluster into one finding)');

    const replay = (await (await fetch(`${API}/v1/sessions/${sessionId}/replay`)).json()) as {
      events: { type: number }[];
      markers: { label: string; node_id: number | null }[];
      session: { chunks: number };
    };
    check(replay.events.some((e) => e.type === 2), `replay has a full snapshot (${replay.events.length} events in ${replay.session.chunks} batches)`);
    check(replay.markers.length === 2 && replay.markers.every((m) => m.node_id !== null), 'replay carries both flags with node ids');
    const stored = JSON.stringify(replay.events);
    for (const [field, value] of Object.entries(PII)) check(!stored.includes(value), `typed ${field} is not in the stored session`);

    // The clusterer groups both dead clicks into one issue.
    const issues = await waitFor('the session to join an issue', async () => {
      const found = await issuesWithSession(sessionId);
      return found.length > 0 && found.every((c) => c.signal_count > 0) ? found : null;
    });
    await new Promise((r) => setTimeout(r, 1500));
    const settled = await issuesWithSession(sessionId);
    check(settled.length === 1, `the session is in exactly one issue (got ${settled.length}${settled[0] ? `: "${settled[0].title}"` : ''})`);
    check(issues[0]?.anchor === 'button#apply-coupon', 'that issue is about button#apply-coupon');

    // ---- 3. The dashboard replay pinpoints the flagged click --------------------------------
    const first = [...dead].sort((a, b) => a.event_time - b.event_time)[0]!;
    const dash = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await dash.goto(`${DASHBOARD}/#/sessions/${sessionId}?signal=${first.signal_id}`);
    await dash.waitForSelector('.replayer-wrapper iframe', { timeout: 20_000 });
    await dash.waitForSelector('.caption', { timeout: 20_000 });
    const outlined = await dash.frameLocator('.replayer-wrapper iframe').locator('.cp-flagged').count();
    check(outlined === 1, 'replay outlines the flagged element in red');
    const caption = (await dash.locator('.caption').innerText()).trim();
    check(/Dead click on button#apply-coupon/.test(caption), `caption: "${caption}"`);
    await dash.screenshot({ path: join(outDir, 'replay-flagged.png') });
    await dash.locator('.player').screenshot({ path: join(outDir, 'replay-player.png') });
    await dash.waitForTimeout(2500);
    await dash.screenshot({ path: join(outDir, 'replay-after.png') });
    await dash.goto(`${DASHBOARD}/#/signals`);
    await dash.waitForSelector('table.signals');
    await dash.screenshot({ path: join(outDir, 'signals.png') });
    await dash.goto(`${DASHBOARD}/#/`);
    await dash.waitForSelector('.issue');
    await dash.screenshot({ path: join(outDir, 'issues.png') });
    if (settled[0]) {
      await dash.goto(`${DASHBOARD}/#/issues/${settled[0].cluster_id}`);
      await dash.waitForSelector('.issue-title');
      await dash.screenshot({ path: join(outDir, 'issue.png') });
    }
    say(`  screenshots in ${outDir}`);
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    say(`FAIL: ${failures.length} check(s) failed`);
    process.exit(1);
  }
  say('PASS: replay check complete (synthetic data)');
}

interface ClusterView {
  cluster_id: string;
  title: string;
  anchor: string;
  signal_count: number;
  sessions: string[];
}

/** Issues (clusters) that include this session. */
async function issuesWithSession(sessionId: string): Promise<ClusterView[]> {
  const list = (await (await fetch(`${API}/v1/clusters?limit=200`)).json()) as { clusters: { cluster_id: string }[] };
  const details = await Promise.all(list.clusters.map(async (c) => ((await (await fetch(`${API}/v1/clusters/${c.cluster_id}`)).json()) as { cluster: ClusterView }).cluster));
  return details.filter((c) => c.sessions.includes(sessionId));
}

main().catch((err: unknown) => {
  say(`e2e failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
