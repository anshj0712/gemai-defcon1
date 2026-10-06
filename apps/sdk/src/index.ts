import { record } from '@rrweb/record';
import { instrumentErrors } from './errors.js';
import { instrumentNavigation } from './nav.js';
import { instrumentNetwork } from './net.js';
import { DEFAULT_BLOCK_SELECTOR, maskInput, maskText, sanitizeEvent } from './privacy.js';
import { watchProbes, type ProbeSpec } from './probes.js';
import { routeTemplate, stripQuery } from './route.js';
import { browserStore, Session } from './session.js';
import { Batcher, gzipText } from './transport.js';

export { DEFAULT_BLOCK_SELECTOR, maskPatterns } from './privacy.js';
export { parseCount, parseMoney, type ProbeSpec } from './probes.js';
export { routeTemplate } from './route.js';

export const SDK_VERSION = '0.1.0';

export interface CpOptions {
  siteKey: string;
  /** Collector base URL, e.g. http://localhost:8080 */
  collectorUrl: string;
  /** Deploy identifier, e.g. a git sha, so findings can be tied to a release. */
  release?: string;
  /** Recording starts only once consent is granted (here or later via grantConsent). */
  consent?: 'granted' | 'pending';
  /** Share of sessions recorded, 0..1 (default 1). Stored on every batch for re-weighting. */
  sampleRate?: number;
  /** Map a path to its route template when the default (numeric and id segments -> :id) is not enough. */
  routeFor?: (path: string) => string;
  /** Extra selectors to block, added to the defaults (payment and identity fields). */
  blockSelector?: string;
  /**
   * Elements whose numbers invariant rules check (allowlist). Only parsed numbers leave the browser,
   * never the text. Example: [{ name: 'cart_total', selector: '#cart-total' }].
   */
  probes?: ProbeSpec[];
  /** ISO currency of money probes, for example "INR". */
  currency?: string;
  flushIntervalMs?: number;
  maxBatchEvents?: number;
}

export interface CpClient {
  grantConsent(): void;
  /** Commerce events that feed revenue at risk, e.g. track('order_placed', { value_minor: 129900, currency: 'INR' }). */
  track(name: string, fields?: { value_minor?: number; currency?: string }): void;
  flush(): Promise<void>;
  stop(): void;
  readonly sessionId: string | null;
  readonly recording: boolean;
}

interface Recording {
  sessionId: string;
  track: CpClient['track'];
  flush(): Promise<void>;
  stop(): void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function startRecording(opts: CpOptions): Recording | null {
  const session = new Session(browserStore());
  const sampleRate = Math.min(1, Math.max(0.0001, opts.sampleRate ?? 1));
  if (!session.sampled(sampleRate)) return null;

  const collectorUrl = opts.collectorUrl.replace(/\/+$/, '');
  const page = () => ({
    route: opts.routeFor?.(window.location.pathname) ?? routeTemplate(window.location.pathname),
    url_path: stripQuery(window.location.pathname) || '/',
  });
  // Captured before the network wrapper is installed, so our own sends are never instrumented.
  const nativeFetch = window.fetch.bind(window);
  const batcher = new Batcher(
    session,
    { siteKey: opts.siteKey, release: opts.release ?? 'unknown', sdkVersion: SDK_VERSION, sampleRate, page },
    {
      url: `${collectorUrl}/v1/ingest`,
      fetch: nativeFetch,
      ...(typeof navigator.sendBeacon === 'function' ? { sendBeacon: (u: string, d: Blob) => navigator.sendBeacon(u, d) } : {}),
      ...(typeof CompressionStream === 'function' ? { gzip: gzipText } : {}),
      now: Date.now,
      sleep,
    },
    opts.maxBatchEvents ?? 200,
  );

  const emitCustom = (tag: string, payload: unknown) => {
    try {
      record.addCustomEvent(tag, payload);
    } catch {
      // Recording stopped; nothing to attach the event to.
    }
  };

  const stopRecord = record({
    emit: (event) => batcher.add(sanitizeEvent(event)),
    maskAllInputs: true,
    maskInputFn: maskInput,
    // Every text node passes through maskText: pattern masking everywhere, full masking in [data-cp-mask].
    maskTextSelector: '*',
    maskTextFn: maskText,
    blockSelector: opts.blockSelector ? `${DEFAULT_BLOCK_SELECTOR}, ${opts.blockSelector}` : DEFAULT_BLOCK_SELECTOR,
    sampling: { mousemove: 50, scroll: 150, input: 'last' },
    checkoutEveryNms: 5 * 60_000,
    recordCanvas: false,
    collectFonts: false,
    inlineImages: false,
  });

  const undo = [
    instrumentNetwork(window, emitCustom, (url) => url.startsWith(collectorUrl)),
    instrumentErrors(window, emitCustom),
    instrumentNavigation(window, emitCustom, {
      route: () => page().route,
      onUnload: () => batcher.flushBeacon(),
      onHidden: () => void batcher.flush(),
    }),
    ...(opts.probes?.length ? [watchProbes(window, opts.probes, emitCustom, opts.currency ? { currency: opts.currency } : {})] : []),
  ];
  const timer = setInterval(() => void batcher.flush(), opts.flushIntervalMs ?? 5000);

  return {
    sessionId: session.id,
    track: (name, fields = {}) => batcher.addBusiness({ name, ...fields, ts: Date.now() }),
    flush: () => batcher.flush(),
    stop: () => {
      clearInterval(timer);
      stopRecord?.();
      for (const u of undo) u();
      batcher.flushBeacon();
    },
  };
}

const NOOP: CpClient = {
  grantConsent: () => undefined,
  track: () => undefined,
  flush: async () => undefined,
  stop: () => undefined,
  sessionId: null,
  recording: false,
};

/** Start the SDK. Safe to call on any page: it never throws, and records nothing without consent. */
export function init(opts: CpOptions): CpClient {
  if (typeof window === 'undefined' || !opts?.siteKey || !opts.collectorUrl) return NOOP;
  let active: Recording | null = null;
  const start = () => {
    if (active) return;
    try {
      active = startRecording(opts);
    } catch {
      active = null;
    }
  };
  if (opts.consent === 'granted') start();
  return {
    grantConsent: start,
    track: (name, fields) => active?.track(name, fields),
    flush: () => active?.flush() ?? Promise.resolve(),
    stop: () => {
      active?.stop();
      active = null;
    },
    get sessionId() {
      return active?.sessionId ?? null;
    },
    get recording() {
      return active !== null;
    },
  };
}
