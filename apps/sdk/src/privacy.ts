/**
 * First line of privacy (the collector scrubs again; ARCHITECTURE.md section 8).
 * Payment and identity fields are blocked outright (recorded as an empty box); every input is
 * masked; all page text passes through a pattern mask for emails, card numbers, and phone numbers;
 * elements marked `data-cp-mask` have their text fully masked.
 */

export const DEFAULT_BLOCK_SELECTOR = [
  '[data-cp-block]',
  '[data-private]',
  'input[autocomplete^="cc-"]',
  'input[name*="card" i]',
  'input[name*="cvv" i]',
  'input[name*="cvc" i]',
  'iframe[src*="checkout"]',
].join(', ');

export const FULL_MASK_SELECTOR = '[data-cp-mask]';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CARD = /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g;
const PHONE = /\+?\(?\d[\d\s().-]{6,}\d/g;
const DATE_LIKE = /^\d{4}[-/.]\d{2}[-/.]\d{2}$|^\d{2}[-/.]\d{2}[-/.]\d{4}$/;

const stars = (s: string) => '*'.repeat(s.length);

/** Masks emails, card-like digit runs, and phone numbers, keeping length so layout holds. */
export function maskPatterns(text: string): string {
  let s = text.includes('@') ? text.replace(EMAIL, stars) : text;
  if (!/\d/.test(s)) return s;
  s = s.replace(CARD, stars);
  return s.replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, '').length;
    return digits < 8 || digits > 15 || DATE_LIKE.test(m.trim()) ? m : stars(m);
  });
}

/** rrweb maskTextFn: full mask inside `[data-cp-mask]`, pattern mask everywhere else. */
export function maskText(text: string, element: HTMLElement | null): string {
  if (element?.closest?.(FULL_MASK_SELECTOR)) return stars(text);
  return maskPatterns(text);
}

/** rrweb Meta event (page load): its href is the full location, query string and fragment included. */
const META_EVENT = 4;

/** Last look at every event before it is batched: page URLs leave without query or fragment. */
export function sanitizeEvent<E extends { type: number; data?: unknown }>(event: E): E {
  if (event.type !== META_EVENT) return event;
  const data = event.data as { href?: unknown } | undefined;
  if (typeof data?.href !== 'string') return event;
  const cut = data.href.search(/[?#]/);
  return cut === -1 ? event : { ...event, data: { ...data, href: data.href.slice(0, cut) } };
}

/** rrweb maskInputFn: inputs never leave the browser, only their length. */
export function maskInput(text: string): string {
  return stars(text);
}
