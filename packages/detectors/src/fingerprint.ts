import { createHash } from 'node:crypto';

/** Deterministic short hex hash. */
export function shortHash(input: string, length = 16): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

/** JSON with sorted keys, so equal objects always hash the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const GENERATED_ID_PREFIX = /^(ember|react-aria|radix-|headlessui-|mui-|downshift-|:r|rc-|el-|uid-|id-)/i;
const HASHED_CLASS = /^(css-|sc-|jsx-|emotion-|svelte-|astro-|makeStyles-|jss)|___[a-z0-9]{5}$|^_[a-z0-9]{5,}$/i;
const STATE_CLASS = /^(active|disabled|loading|selected|open|opened|closed|focus|focused|hover|visible|hidden|show|shown|collapsed|expanded|checked|pressed|current|is-.+|has-.+)$/i;

/** Letters and digits interleaved with no separator, like `a1b2c3` or `x7Kq9`: typical of generated names. */
function looksRandom(token: string): boolean {
  if (token.length < 5 || /[-_]/.test(token)) return false;
  const digits = token.replace(/\D/g, '').length;
  const letters = token.replace(/[^a-z]/gi, '').length;
  return digits >= 2 && letters >= 2;
}

function isGeneratedId(id: string): boolean {
  return (
    GENERATED_ID_PREFIX.test(id) ||
    /\d{3,}/.test(id) ||
    /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ||
    /(^|[-_])[0-9a-f]{6,}$/i.test(id) ||
    looksRandom(id)
  );
}

function isUnstableClass(c: string): boolean {
  return HASHED_CLASS.test(c) || STATE_CLASS.test(c) || looksRandom(c);
}

const TOKEN = /(#[^.#[:\s>+~]+)|(\.[^.#[:\s>+~]+)|(\[[^\]]*\])|(:[a-z-]+(?:\([^)]*\))?)/gi;

function normalizeCompound(compound: string): string {
  const tag = /^[a-z][a-z0-9-]*/i.exec(compound)?.[0]?.toLowerCase() ?? '';
  let out = tag;
  for (const m of compound.slice(tag.length).matchAll(TOKEN)) {
    const [token] = m;
    if (token.startsWith('#')) {
      if (!isGeneratedId(token.slice(1))) out += token;
    } else if (token.startsWith('.')) {
      if (!isUnstableClass(token.slice(1))) out += token;
    } else if (token.startsWith('[')) {
      out += token;
    }
    // Pseudo-classes such as :nth-child(3) are positional and dropped.
  }
  return out || '*';
}

/**
 * Selector used in fingerprints: strips generated ids, hashed and state classes, and positional
 * pseudo-classes so the same control on every session maps to the same string.
 */
export function normalizeSelector(selector: string): string {
  return selector
    .trim()
    .split(/\s*([>+~])\s*|\s+/)
    .filter((part) => part !== undefined && part !== '')
    .map((part) => (/^[>+~]$/.test(part) ? part : normalizeCompound(part)))
    .join(' ');
}

function isDynamicSegment(seg: string): boolean {
  return (
    /^\d+$/.test(seg) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ||
    /^[0-9a-f]{8,}$/i.test(seg) ||
    (seg.length >= 16 && /\d/.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg))
  );
}

/** `/product/123?x=1` -> `/product/:id`. Already-templated segments (`:id`) are kept. */
export function routeTemplate(route: string): string {
  const path = route.split(/[?#]/)[0] ?? '';
  const segments = path.split('/').filter(Boolean).map((s) => (s.startsWith(':') ? s : isDynamicSegment(s) ? ':id' : s));
  return `/${segments.join('/')}`;
}

export interface FingerprintParts {
  detector: string;
  route: string;
  selector?: string | null;
  errorSignature?: string | null;
}

/** hash(detector, route template, normalized selector, error signature) */
export function fingerprint(parts: FingerprintParts): string {
  return shortHash(
    [parts.detector, routeTemplate(parts.route), parts.selector ? normalizeSelector(parts.selector) : '', parts.errorSignature ?? ''].join('|'),
  );
}
