import { CUSTOM_TAGS, type NetPayloadShape } from '@cp/schema/tags';
import { urlRoute } from './route.js';

type Emit = (tag: string, payload: unknown) => void;

export interface NetTarget {
  fetch?: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
  location: { href: string };
  performance?: { now(): number };
}

/**
 * Wraps fetch and XMLHttpRequest to emit `cp.net` start/end events: method, route template, status,
 * and duration only. No URL query, headers, or bodies. `ignore` skips our own collector calls.
 * Returns a function that restores the originals.
 */
export function instrumentNetwork(win: NetTarget, emit: Emit, ignore: (absoluteUrl: string) => boolean): () => void {
  const clock = () => win.performance?.now() ?? Date.now();
  const absolute = (url: string) => {
    try {
      return new URL(url, win.location.href).href;
    } catch {
      return url;
    }
  };
  const start = (method: string, url: string): ((status: number) => void) => {
    const route = urlRoute(url, win.location.href);
    const m = method.toUpperCase();
    emit(CUSTOM_TAGS.net, { phase: 'start', method: m, route } satisfies NetPayloadShape);
    const t0 = clock();
    let done = false;
    return (status) => {
      if (done) return;
      done = true;
      emit(CUSTOM_TAGS.net, { phase: 'end', method: m, route, status, duration_ms: Math.max(0, Math.round(clock() - t0)) } satisfies NetPayloadShape);
    };
  };

  const restores: (() => void)[] = [];

  const originalFetch = win.fetch;
  if (typeof originalFetch === 'function') {
    const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (ignore(absolute(url))) return originalFetch.call(win, input, init);
      const method = init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET');
      const end = start(method, url);
      return originalFetch.call(win, input, init).then(
        (res) => {
          end(res.status);
          return res;
        },
        (err: unknown) => {
          end(0);
          throw err;
        },
      );
    };
    win.fetch = wrapped as typeof fetch;
    restores.push(() => {
      win.fetch = originalFetch;
    });
  }

  const XHR = win.XMLHttpRequest;
  if (typeof XHR === 'function') {
    const info = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    const proto = XHR.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      info.set(this, { method, url: String(url) });
      return (originalOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof proto.open;
    proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const meta = info.get(this);
      if (meta && !ignore(absolute(meta.url))) {
        const end = start(meta.method, meta.url);
        this.addEventListener('loadend', () => end(this.status));
      }
      return originalSend.call(this, body);
    };
    restores.push(() => {
      proto.open = originalOpen;
      proto.send = originalSend;
    });
  }

  return () => {
    for (const r of restores.reverse()) r();
  };
}
