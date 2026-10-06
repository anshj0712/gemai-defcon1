import type { IngestEnvelope } from '@cp/schema';

/**
 * Second-pass scrubber (ARCHITECTURE.md section 8). The SDK masks first; this runs again on the
 * whole batch before anything is stored, because client masking alone is not trusted (rrweb only
 * masks passwords by default, and hidden inputs have escaped maskAllInputs in the past).
 *
 * Replacements keep the original length (asterisks) so replays keep their layout.
 */

export interface ScrubStats {
  emails: number;
  cards: number;
  phones: number;
  inputValues: number;
  inputTexts: number;
  textareas: number;
  urls: number;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** 13 to 19 digits, optionally separated by single spaces or dashes. */
const CARD = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g;
/** Candidate phone numbers; accepted only with 8 to 15 digits and not shaped like a date. */
const PHONE = /\+?\(?\d[\d\s().-]{6,}\d/g;
const DATE_LIKE = /^\d{4}[-/.]\d{2}[-/.]\d{2}$|^\d{2}[-/.]\d{2}[-/.]\d{4}$/;

const stars = (s: string) => '*'.repeat(s.length);

export function scrubString(input: string, stats: ScrubStats): string {
  let s = input;
  if (s.includes('@')) {
    s = s.replace(EMAIL, (m) => {
      stats.emails++;
      return stars(m);
    });
  }
  if (!/\d/.test(s)) return s;
  s = s.replace(CARD, (m) => {
    stats.cards++;
    return stars(m);
  });
  s = s.replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, '').length;
    if (digits < 8 || digits > 15 || DATE_LIKE.test(m.trim())) return m;
    stats.phones++;
    return stars(m);
  });
  return s;
}

/** Drop the query string and fragment from a URL or path, keeping everything else. */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

const URL_KEYS = new Set(['href', 'action', 'url', 'route', 'url_path']);

/**
 * Geometry and layout attributes (SVG path data, viewBox, coordinates, transforms). They are runs of
 * numbers that look like phone numbers to the pattern scrubber but can never hold anything a
 * shopper typed, and scrubbing them breaks every icon and illustration in the replay.
 */
const GEOMETRY_ATTRS = new Set([
  'd', 'points', 'viewbox', 'transform', 'gradienttransform', 'patterntransform', 'preserveaspectratio',
  'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'dx', 'dy', 'width', 'height', 'offset',
  'stroke-width', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'opacity', 'fill-opacity', 'stroke-opacity',
]);
const ELEMENT = 2;
const TEXT = 3;
const INPUT_SOURCE = 5;

interface Ctx {
  /** Key under which this value sits in its parent object. */
  key: string;
  /** True while walking the children of a <textarea>, whose text is user input. */
  inTextarea: boolean;
}

function scrubUrl(value: string, stats: ScrubStats): string {
  const stripped = stripQuery(value);
  if (stripped !== value) stats.urls++;
  return scrubString(stripped, stats);
}

function walk(value: unknown, ctx: Ctx, stats: ScrubStats): unknown {
  if (typeof value === 'string') {
    return URL_KEYS.has(ctx.key) ? scrubUrl(value, stats) : scrubString(value, stats);
  }
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, { ...ctx, key: `${ctx.key}[]` }, stats));
  }
  if (value === null || typeof value !== 'object') return value;

  const obj = value as Record<string, unknown>;

  // Attribute maps: on serialized elements, and inside mutation attribute records.
  if (ctx.key === 'attributes') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'value' && typeof v === 'string') {
        if (v !== '') stats.inputValues++;
        out[k] = stars(v);
      } else if (GEOMETRY_ATTRS.has(k.toLowerCase()) && typeof v === 'string') {
        out[k] = v;
      } else {
        out[k] = walk(v, { key: k, inTextarea: ctx.inTextarea }, stats);
      }
    }
    return out;
  }

  // rrweb Input incremental event: the typed text itself.
  if (obj.source === INPUT_SOURCE && typeof obj.text === 'string' && 'isChecked' in obj) {
    if (obj.text !== '') stats.inputTexts++;
    return { ...obj, text: stars(obj.text) };
  }

  // Text node inside a <textarea>: user input rendered as text.
  if (ctx.inTextarea && obj.type === TEXT && typeof obj.textContent === 'string') {
    if (obj.textContent !== '') stats.textareas++;
    return { ...obj, textContent: stars(obj.textContent) };
  }

  const inTextarea = ctx.inTextarea || (obj.type === ELEMENT && typeof obj.tagName === 'string' && obj.tagName.toLowerCase() === 'textarea');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = walk(v, { key: k, inTextarea }, stats);
  return out;
}

export function emptyStats(): ScrubStats {
  return { emails: 0, cards: 0, phones: 0, inputValues: 0, inputTexts: 0, textareas: 0, urls: 0 };
}

/** Returns a scrubbed copy of the envelope; the input is not modified. */
export function scrubEnvelope(envelope: IngestEnvelope): { envelope: IngestEnvelope; stats: ScrubStats } {
  const stats = emptyStats();
  const events = walk(envelope.events, { key: 'events', inTextarea: false }, stats) as IngestEnvelope['events'];
  const business_events = walk(envelope.business_events, { key: 'business_events', inTextarea: false }, stats) as IngestEnvelope['business_events'];
  const page = { route: scrubUrl(envelope.page.route, stats), url_path: scrubUrl(envelope.page.url_path, stats) };
  return { envelope: { ...envelope, page, events, business_events }, stats };
}

/** Only the non-zero counters, for compact logs. */
export function nonZero(stats: ScrubStats): Partial<ScrubStats> {
  return Object.fromEntries(Object.entries(stats).filter(([, v]) => v > 0)) as Partial<ScrubStats>;
}
