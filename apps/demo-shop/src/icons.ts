/** Inline SVG icons (24px grid, currentColor). */
const svg = (body: string, size = 24) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20 20"/>'),
  heart: svg('<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20Z"/>'),
  heartFilled: `<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20Z"/></svg>`,
  bag: svg('<path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>'),
  check: svg('<circle cx="12" cy="12" r="9"/><path d="m8 12 2.7 2.7L16 9.5"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  plus: svg('<path d="M12 6v12M6 12h12"/>', 18),
  minus: svg('<path d="M6 12h12"/>', 18),
  trash: svg('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>', 18),
  arrow: svg('<path d="M7 17 17 7M9 7h8v8"/>', 16),
  play: svg('<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5.5 3.5-5.5 3.5v-7Z" fill="currentColor"/>', 18),
};

/** The fictional STRIDE wordmark. */
export const logo = `<span class="logo-mark" aria-hidden="true">STRIDE</span>`;
