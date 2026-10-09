import { describe, expect, it } from 'vitest';
import { applyCouponScenario, NODE } from '@cp/testkit';
import { PlaywrightScreenshotter } from '../src/visual/screenshot.js';

/**
 * Renders a real frame with the rrweb replayer in headless Chromium. Needs a browser, so it runs only
 * with CP_BROWSER_TESTS set: `bundled` (Playwright's Chromium), an installed channel such as chrome, or a path to a Chromium executable.
 */
const browser = process.env.CP_BROWSER_TESTS;

describe.skipIf(!browser)('screenshot of a flagged moment (real browser, synthetic session)', () => {
  it('renders the masked replay at the flag as a PNG', async () => {
    const start = 1_790_000_000_000;
    const s = applyCouponScenario({ start });
    const shooter = new PlaywrightScreenshotter({ channel: browser === 'bundled' ? undefined : browser, timeoutMs: 20_000 });
    try {
      const clickAt = s.clickTimes[s.deadClickIndexes[0]!]!;
      const { png, offsetMs } = await shooter.capture(s.events, {
        signal_id: 'sig-1', detector: 'dead_click', label: 'Dead click', replay_ts: clickAt, event_time: clickAt, seq: 0,
        selector: 'button#apply-coupon', node_id: NODE.applyCoupon, fingerprint: 'f',
      });
      expect(png.subarray(0, 4).toString('hex')).toBe('89504e47');
      expect(png.length).toBeGreaterThan(1000);
      expect(offsetMs).toBe(clickAt - s.events[0]!.timestamp + 600);
    } finally {
      await shooter.close();
    }
  }, 60_000);
});
