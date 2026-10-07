import { isAbsolute } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

/** Shared Playwright helpers for the e2e check and the session simulator. All shoppers are synthetic. */

export const URLS = {
  shop: process.env.SHOP_URL ?? 'http://localhost:5173',
  api: process.env.API_URL ?? 'http://localhost:8082',
  dashboard: process.env.DASHBOARD_URL ?? 'http://localhost:5174',
  collector: process.env.COLLECTOR_URL ?? 'http://localhost:8080',
};

export const say = (s: string) => process.stdout.write(`${s}\n`);

export const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/**
 * Launch the installed browser (throwaway profile). `channel` is chrome or msedge, or a path to a
 * Chromium executable (for machines without Chrome, such as CI containers). When Chrome has an update staged, the first launch
 * applies it and exits straight away ("Target page, context or browser has been closed"); a retry works.
 */
export async function launchBrowser(channel: string, headed: boolean): Promise<Browser> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await chromium.launch({ ...(isAbsolute(channel) ? { executablePath: channel } : { channel }), headless: !headed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= 3 || !/has been closed|exited|Process failed to launch/i.test(message)) {
        throw new Error(`${channel} would not start: ${message.split('\n')[0]}\nTry again, or run with --channel msedge.`);
      }
      say(`  ${channel} closed during startup (often a pending browser update being applied); retrying…`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/** Fails fast with a useful message when `pnpm dev` is not running. */
export async function requireServices(names: (keyof typeof URLS)[]): Promise<void> {
  for (const name of names) {
    const url = name === 'shop' || name === 'dashboard' ? URLS[name] : `${URLS[name]}/healthz`;
    const ok = await fetch(url).then((r) => r.ok, () => false);
    if (!ok) throw new Error(`${name} is not reachable at ${url}. Start everything with: pnpm dev`);
  }
}

export async function moveAndClick(page: Page, selector: string, opts: { steps?: number; jitter?: () => number } = {}): Promise<void> {
  const target = page.locator(selector).first();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`not visible: ${selector}`);
  const jitter = opts.jitter ?? Math.random;
  const x = box.x + box.width / 2 + (jitter() * 6 - 3);
  const y = box.y + box.height / 2 + (jitter() * 4 - 2);
  await page.mouse.move(x, y, { steps: opts.steps ?? 18 });
  await page.waitForTimeout(120);
  await page.mouse.click(x, y);
}

/** Click again where the mouse already is (a frustrated repeat press). */
export async function clickInPlace(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`not visible: ${selector}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

export async function typeInto(page: Page, selector: string, text: string, opts: { steps?: number; replace?: boolean } = {}): Promise<void> {
  await moveAndClick(page, selector, opts);
  if (opts.replace) await page.keyboard.press('Control+A');
  await page.keyboard.type(text, { delay: 35 });
}

export async function waitFor<T>(what: string, probe: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** What the demo shop exposes on window (read inside page.evaluate). */
export interface PageGlobals {
  cp?: { sessionId: string | null; flush(): Promise<void> };
}

export const sessionIdOf = (page: Page) => page.evaluate(() => (globalThis as PageGlobals).cp?.sessionId ?? null);
export const flushSdk = (page: Page) => page.evaluate(() => (globalThis as PageGlobals).cp?.flush());
