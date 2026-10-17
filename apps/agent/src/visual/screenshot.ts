import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import type { Browser } from 'playwright';
import type { ReplayMarker } from '@cp/platform';
import type { RrwebEvent } from '@cp/schema';

/**
 * Renders one frame of a session at a flagged moment, from the stored (already scrubbed and masked)
 * rrweb events, with the flagged element outlined in red. This is the only image the root-cause
 * agent sees (AGENTS.md rule 2): the masking has already happened in the SDK and the collector, and
 * the page is rebuilt by the rrweb replayer in a sandboxed iframe with scripts disabled.
 */
export interface Screenshotter {
  capture(events: readonly RrwebEvent[], marker: ReplayMarker): Promise<{ png: Buffer; offsetMs: number }>;
  close(): Promise<void>;
}

/**
 * How far past the flagged event the frame is taken for a data rule, so the wrong total has time to show. A click
 * detector's frame is taken at the click itself: a shopper often moves on within a second (a dead Apply Coupon, then
 * on to checkout), and a later frame would show some other page.
 */
export const AFTER_FLAG_MS = 600;
export const afterFlagMs = (detector: string): number => (detector === 'invariant_check' ? AFTER_FLAG_MS : 0);
const MAX_WIDTH = 1280;
const MAX_HEIGHT = 900;

const require = createRequire(import.meta.url);
let replayBundle: string | null = null;

/** The rrweb replayer as a UMD script (global rrwebReplay), read once from the installed package. */
function resolveBundle(): string {
  if (replayBundle) return replayBundle;
  // The package's exports map hides the UMD file; it sits next to the CommonJS entry.
  const entry = require.resolve('@rrweb/replay');
  replayBundle = readFileSync(join(dirname(entry), 'replay.umd.min.cjs'), 'utf8');
  return replayBundle;
}

/** Viewport from the recording's last Meta event before the frame (rrweb type 4). */
function viewport(events: readonly RrwebEvent[], at: number): { width: number; height: number } {
  let w = 1280;
  let h = 800;
  for (const e of events) {
    if (e.timestamp > at) break;
    const data = (e as { data?: { width?: unknown; height?: unknown } }).data;
    if (e.type === 4 && typeof data?.width === 'number' && typeof data.height === 'number') {
      w = data.width;
      h = data.height;
    }
  }
  return { width: Math.min(Math.max(320, Math.round(w)), MAX_WIDTH), height: Math.min(Math.max(320, Math.round(h)), MAX_HEIGHT) };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#fff;overflow:hidden}
.replayer-wrapper{position:relative;transform-origin:top left}
.replayer-wrapper iframe{border:0;display:block}
.replayer-mouse{display:none}
</style></head><body><div id="root"></div></body></html>`;

const FLAGGED_CSS = '.cp-flagged{outline:4px solid #ef4444 !important;outline-offset:3px !important;box-shadow:0 0 0 10px rgba(239,68,68,.25) !important}';

export interface PlaywrightScreenshotterOptions {
  /** Installed browser channel (chrome, msedge), a path to a Chromium executable, or undefined for Playwright's bundled Chromium. */
  channel: string | undefined;
  timeoutMs: number;
}

export class PlaywrightScreenshotter implements Screenshotter {
  private browser: Promise<Browser> | null = null;

  constructor(private readonly opts: PlaywrightScreenshotterOptions) {}

  private launch(): Promise<Browser> {
    const c = this.opts.channel;
    const how = !c ? {} : isAbsolute(c) ? { executablePath: c } : { channel: c };
    this.browser ??= import('playwright').then(({ chromium }) => chromium.launch({ headless: true, ...how }));
    this.browser.catch(() => (this.browser = null));
    return this.browser;
  }

  async capture(events: readonly RrwebEvent[], marker: ReplayMarker): Promise<{ png: Buffer; offsetMs: number }> {
    if (events.length === 0) throw new Error('no events to render');
    const start = events[0]!.timestamp;
    const end = events.at(-1)!.timestamp;
    const at = Math.min(end, Math.max(start, marker.replay_ts + afterFlagMs(marker.detector)));
    const offsetMs = at - start;
    const vp = viewport(events, at);
    const browser = await this.launch();
    const context = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, javaScriptEnabled: true, offline: true });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(this.opts.timeoutMs);
      await page.setContent(PAGE);
      await page.addScriptTag({ content: resolveBundle() });
      await page.evaluate(
        async ({ events, offsetMs, nodeId, selector, css }) => {
          type Mirror = { getNode(id: number): Node | null };
          type Replayer = { pause(t: number): void; iframe: HTMLIFrameElement; getMirror(): Mirror };
          const lib = (window as unknown as { rrwebReplay: { Replayer: new (e: unknown[], o: unknown) => Replayer } }).rrwebReplay;
          const replayer = new lib.Replayer(events, {
            root: document.getElementById('root'),
            mouseTail: false,
            showWarning: false,
            showDebug: false,
            triggerFocus: false,
            insertStyleRules: [css],
            // The rebuilt page runs no scripts: rrweb sandboxes the iframe.
            UNSAFE_replayCanvas: false,
          });
          replayer.pause(offsetMs);
          await new Promise((r) => setTimeout(r, 150));
          const doc = replayer.iframe.contentDocument;
          const byId = nodeId !== null ? (replayer.getMirror().getNode(nodeId) as Element | null) : null;
          let el: Element | null = byId && byId.isConnected ? byId : null;
          if (!el && selector) {
            try {
              el = doc?.querySelector(selector) ?? null;
            } catch {
              el = null;
            }
          }
          if (el) {
            el.classList.add('cp-flagged');
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
          }
          // Images inside the replay load from the network, which is off: do not wait for them.
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        },
        { events: events as unknown[], offsetMs, nodeId: marker.node_id, selector: marker.selector, css: FLAGGED_CSS },
      );
      const frame = page.locator('.replayer-wrapper iframe');
      const png = await frame.screenshot({ type: 'png', animations: 'disabled' });
      return { png, offsetMs };
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) await (await b.catch(() => null))?.close();
  }
}
