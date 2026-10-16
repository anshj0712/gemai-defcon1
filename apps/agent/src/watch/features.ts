import type { RecordedProbeSpec, WatchFeature } from '@cp/schema';
import type { SessionProbes } from '../rules/scan.js';

/**
 * The numbers the churn watcher looks at, per session: every probe the session reports (declared, request,
 * recorded) and, in discover mode, every short number on its recorded pages nobody probes yet. Each is reduced
 * to the session's largest value. Numbers only; the page text stays in the recording.
 */

export interface SessionNumbers {
  /** feature key -> the session's largest value. */
  values: Map<string, number>;
  /** feature key -> what the number is. */
  features: Map<string, WatchFeature>;
}

const MONEY_NAME = /(total|price|fee|discount|amount|subtotal|cost|charge)/;

/** snake_case probe name for a page element: `span#delivery-fee` -> `delivery_fee`, `p.eta.small` -> `eta_small`. */
export function nameForSelector(selector: string): string {
  const last = selector.split(/\s+|>/).filter(Boolean).pop() ?? selector;
  const id = /#([A-Za-z0-9_-]+)/.exec(last)?.[1];
  const attr = /\[[a-z-]+="?([A-Za-z0-9_-]+)"?\]/.exec(last)?.[1];
  const classes = [...last.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]).join('_');
  const raw = id ?? attr ?? (classes || last.replace(/[^A-Za-z0-9]+/g, '_'));
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return /^[a-z]/.test(slug) ? slug : `el_${slug || 'number'}`;
}

/** Routes where a number says nothing about leaving: after the order is placed. */
const AFTER_ORDER = /^\/order(\/|$)/;

export function sessionNumbers(s: SessionProbes, registry: readonly RecordedProbeSpec[]): SessionNumbers {
  const values = new Map<string, number>();
  const features = new Map<string, WatchFeature>();
  const recordedKind = new Map(registry.map((p) => [p.name, p.kind]));
  // A page element a registered probe already reads is that probe, not a new candidate.
  const registered = new Set(registry.flatMap((p) => (p.routes?.length ? p.routes : [null]).map((r) => `${r}|${p.selector.replace(/^[a-z]+(?=[#.[])/, '')}`)));
  const keep = (key: string, feature: WatchFeature, v: number) => {
    if (!features.has(key)) features.set(key, feature);
    const prev = values.get(key);
    if (prev === undefined || v > prev) values.set(key, v);
  };

  for (const c of s.chunks) {
    for (const p of c.probes) {
      const source = p.source ?? 'declared';
      for (const [name, list] of Object.entries(p.values)) {
        if (list.length === 0) continue;
        const unit: WatchFeature['unit'] =
          source === 'request' ? (name.endsWith('_ms') ? 'ms' : 'status') : source === 'recorded' ? (recordedKind.get(name) ?? 'count') : MONEY_NAME.test(name) ? 'money' : 'count';
        keep(`probe:${name}`, { key: `probe:${name}`, name, source, selector: null, route: p.route ?? c.pageRoute, unit }, Math.max(...list));
      }
    }
  }

  for (const d of s.discovered ?? []) {
    if (d.route && AFTER_ORDER.test(d.route)) continue;
    for (const cand of d.candidates) {
      // Declared probes are already numbers above; registered recorded probes too.
      if (cand.selector.includes('data-cp-probe')) continue;
      const bare = cand.selector.replace(/^[a-z]+(?=[#.[])/, '');
      if (registered.has(`${d.route}|${bare}`) || registered.has(`null|${bare}`)) continue;
      const key = `dom:${d.route ?? ''}|${cand.selector}`;
      keep(key, { key, name: nameForSelector(cand.selector), source: 'discovered', selector: cand.selector, route: d.route, unit: cand.kind }, Math.max(...cand.values));
    }
  }
  return { values, features };
}
