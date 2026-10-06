/** Drop the query string and fragment. */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

function isDynamicSegment(seg: string): boolean {
  return (
    /^\d+$/.test(seg) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ||
    /^[0-9a-f]{8,}$/i.test(seg) ||
    (seg.length >= 16 && /\d/.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg))
  );
}

/**
 * `/product/123?x=1` -> `/product/:id`. Same rules as the server's routeTemplate
 * (packages/detectors/src/fingerprint.ts), duplicated here so the SDK stays dependency-free.
 */
export function routeTemplate(path: string): string {
  const segments = stripQuery(path)
    .split('/')
    .filter(Boolean)
    .map((s) => (s.startsWith(':') ? s : isDynamicSegment(s) ? ':id' : s));
  return `/${segments.join('/')}`;
}

/** Path of a URL (absolute or relative) as a route template, without origin or query. */
export function urlRoute(url: string, base: string): string {
  try {
    return routeTemplate(new URL(url, base).pathname);
  } catch {
    return routeTemplate(url);
  }
}
