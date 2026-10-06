/**
 * rrweb Custom event tags shared by the browser SDK and the normalizer. This module has no
 * dependencies so the SDK can import it (`@cp/schema/tags`) without pulling zod into the bundle.
 */
export const CUSTOM_TAGS = {
  /**
   * A fetch/XHR started (phase "start", emitted at the call) or finished (phase "end", timestamp =
   * completion). The start event matters: dead_click must see that a click triggered a request
   * even when the response arrives after its window.
   */
  net: 'cp.net',
  /** window.onerror or unhandledrejection. */
  error: 'cp.error',
  /** A registered probe's parsed value changed. */
  probe: 'cp.probe',
  /** SPA route change, or the page is being unloaded (emitted on pagehide before the final flush). */
  nav: 'cp.nav',
} as const;

/** Prefix of the marker events the replay viewer injects for flagged moments (never recorded). */
export const FLAG_TAG_PREFIX = 'cp.flag.';

export interface NetPayloadShape {
  phase: 'start' | 'end';
  method: string;
  route: string;
  status?: number;
  duration_ms?: number;
}

export interface ErrorPayloadShape {
  kind: 'error' | 'unhandledrejection';
  signature: string;
}

export interface NavPayloadShape {
  reason: 'spa' | 'unload';
  route?: string;
}

export interface ProbePayloadShape {
  /** probe name -> parsed numbers (money in minor units, counts as integers), one per matched element. */
  values: Record<string, number[]>;
  currency?: string;
}
