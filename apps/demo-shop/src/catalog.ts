/**
 * STRIDE: a fictional athletic brand for the synthetic demo store. Products, prices, and stock are
 * made up. Product images are inline SVG, so session replays show them exactly.
 */

export const BRAND = 'STRIDE';

export interface Colorway {
  upper: string;
  overlay: string;
  heel: string;
  midsole: string;
  outsole: string;
  laces: string;
  accent: string;
}

export type Category = 'running' | 'lifestyle' | 'trail' | 'court' | 'training';

export interface Product {
  id: string;
  name: string;
  /** Subtitle under the name, e.g. "Men's Road Running Shoes". */
  kind: string;
  gender: 'men' | 'women' | 'unisex';
  category: Category;
  price_minor: number;
  /** Original price when on sale. */
  compare_minor?: number;
  badge?: 'Just In' | 'Bestseller' | 'Sustainable Materials';
  colours: number;
  colorway: Colorway;
  description: string;
  /** Sizes shown but not purchasable. */
  soldOut: string[];
}

export const SIZES = ['UK 6', 'UK 6.5', 'UK 7', 'UK 7.5', 'UK 8', 'UK 8.5', 'UK 9', 'UK 9.5', 'UK 10', 'UK 10.5', 'UK 11', 'UK 12'];

const cw = (upper: string, overlay: string, heel: string, midsole: string, outsole: string, laces: string, accent: string): Colorway => ({
  upper,
  overlay,
  heel,
  midsole,
  outsole,
  laces,
  accent,
});

export const PRODUCTS: Product[] = [
  {
    id: 'velocity-runner',
    name: 'Velocity Runner 4',
    kind: "Men's Road Running Shoes",
    gender: 'men',
    category: 'running',
    price_minor: 1079500,
    badge: 'Just In',
    colours: 4,
    colorway: cw('#f4f4f4', '#111111', '#111111', '#ffffff', '#1c1c1c', '#ffffff', '#111111'),
    description: 'A responsive foam midsole and a breathable engineered mesh upper for everyday miles. Built to feel fast from the first step to the last.',
    soldOut: ['UK 6', 'UK 12'],
  },
  {
    id: 'cloudline-lite',
    name: 'Cloudline Lite',
    kind: "Women's Road Running Shoes",
    gender: 'women',
    category: 'running',
    price_minor: 929500,
    colours: 3,
    colorway: cw('#d9d9d9', '#9a9a9a', '#ffffff', '#fafafa', '#bdbdbd', '#ffffff', '#6b6b6b'),
    description: 'Soft underfoot and light on the scale. The rocker shape rolls you forward so easy runs stay easy.',
    soldOut: ['UK 9.5'],
  },
  {
    id: 'court-classic',
    name: 'Court Classic Low',
    kind: "Men's Shoes",
    gender: 'men',
    category: 'court',
    price_minor: 829500,
    badge: 'Bestseller',
    colours: 6,
    colorway: cw('#ffffff', '#ececec', '#111111', '#ffffff', '#b98a55', '#ffffff', '#111111'),
    description: 'Clean leather, a cupsole that lasts, and a gum outsole. The court shoe that went off the court and never looked back.',
    soldOut: [],
  },
  {
    id: 'trail-ascent',
    name: 'Trail Ascent GTX',
    kind: "Men's Trail Running Shoes",
    gender: 'men',
    category: 'trail',
    price_minor: 1299500,
    colours: 2,
    colorway: cw('#2e2e2e', '#4b4b4b', '#111111', '#d4d4d4', '#121212', '#d4d4d4', '#ff6a13'),
    description: 'A waterproof upper and multi-directional lugs for wet rock and loose dirt. Your weekends just got longer.',
    soldOut: ['UK 7', 'UK 7.5'],
  },
  {
    id: 'tempo-knit',
    name: 'Tempo Knit 2',
    kind: "Women's Running Shoes",
    gender: 'women',
    category: 'running',
    price_minor: 1029500,
    compare_minor: 1279500,
    colours: 2,
    colorway: cw('#161616', '#2c2c2c', '#000000', '#1a1a1a', '#000000', '#161616', '#9b9b9b'),
    description: 'A sock-like knit that moves with you and a snappy plate for tempo days. Triple black, zero distractions.',
    soldOut: [],
  },
  {
    id: 'street-mid',
    name: "Street Mid '89",
    kind: 'Shoes',
    gender: 'unisex',
    category: 'lifestyle',
    price_minor: 1149500,
    badge: 'Sustainable Materials',
    colours: 5,
    colorway: cw('#ffffff', '#151515', '#151515', '#efe8da', '#efe8da', '#ffffff', '#151515'),
    description: 'An archive silhouette rebuilt with at least 20% recycled content by weight. Same attitude, lighter footprint.',
    soldOut: ['UK 11'],
  },
  {
    id: 'studio-trainer',
    name: 'Studio Trainer',
    kind: "Women's Training Shoes",
    gender: 'women',
    category: 'training',
    price_minor: 699500,
    compare_minor: 849500,
    colours: 3,
    colorway: cw('#8e8e8e', '#5e5e5e', '#ffffff', '#ffffff', '#cfcfcf', '#ffffff', '#ffffff'),
    description: 'A wide, stable base for lifts and a flexible forefoot for everything in between.',
    soldOut: ['UK 8'],
  },
  {
    id: 'pace-racer',
    name: 'Pace Racer Elite',
    kind: 'Road Racing Shoes',
    gender: 'unisex',
    category: 'running',
    price_minor: 1699500,
    badge: 'Just In',
    colours: 1,
    colorway: cw('#ededed', '#d1d1d1', '#1a1a1a', '#ffffff', '#1a1a1a', '#1a1a1a', '#ff4d1a'),
    description: 'Our lightest racer: a full-length plate, a high-rebound foam stack, and nothing you do not need on race day.',
    soldOut: ['UK 6', 'UK 6.5', 'UK 12'],
  },
];

export const productById = (id: string) => PRODUCTS.find((p) => p.id === id);

export const CATEGORIES: { path: string; label: string; title: string; filter: (p: Product) => boolean }[] = [
  { path: '/', label: 'New & Featured', title: 'New & Featured', filter: () => true },
  { path: '/men', label: 'Men', title: "Men's Shoes", filter: (p) => p.gender === 'men' || p.gender === 'unisex' },
  { path: '/women', label: 'Women', title: "Women's Shoes", filter: (p) => p.gender === 'women' || p.gender === 'unisex' },
  { path: '/running', label: 'Running', title: 'Running Shoes', filter: (p) => p.category === 'running' || p.category === 'trail' },
  { path: '/sale', label: 'Sale', title: 'Sale', filter: (p) => p.compare_minor !== undefined },
];

/**
 * A sneaker in side profile, toe to the right. `view` varies the framing for the product gallery.
 * Shapes are generic; no real brand's marks.
 */
export function shoeSvg(c: Colorway, opts: { view?: 'side' | 'mirror' | 'tilt' | 'detail'; label?: string } = {}): string {
  const view = opts.view ?? 'side';
  const transform =
    view === 'mirror' ? 'translate(480 0) scale(-1 1)' : view === 'tilt' ? 'rotate(-12 240 170)' : view === 'detail' ? 'translate(-210 -150) scale(1.9)' : '';
  // Laces sit across the lace line, which runs from the tongue (≈250,104) down to the vamp (≈318,150).
  const laces = Array.from({ length: 5 }, (_, i) => {
    const x = 254 + i * 15;
    const y = 108 + i * 10;
    return `<path d="M${x - 6} ${y + 8} L${x + 6} ${y - 8}" stroke="${c.laces}" stroke-width="5" stroke-linecap="round"/>`;
  }).join('');
  const upper =
    'M56 206 C50 170 52 130 66 104 C72 94 84 90 98 92 C116 95 130 106 144 116 C160 126 180 126 196 116 ' +
    'C206 108 214 92 222 82 C228 76 238 76 242 84 C252 108 268 126 292 138 C330 156 370 166 404 176 ' +
    'C434 186 452 198 454 214 L450 214 Z';
  return `<svg viewBox="0 0 480 300" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${opts.label ?? 'Shoe'}">
  <ellipse cx="252" cy="268" rx="196" ry="11" fill="#000" opacity="0.07"/>
  <g transform="${transform}">
    <path d="M60 240 C52 240 47 248 51 254 C55 260 64 262 76 262 L420 262 C442 262 456 253 457 242 L457 236 Z" fill="${c.outsole}"/>
    <path d="M54 204 L452 214 C463 217 466 231 457 238 L62 244 C49 244 44 233 45 221 C46 210 49 205 54 204 Z" fill="${c.midsole}" stroke="#000" stroke-opacity="0.08" stroke-width="1.5"/>
    <path d="M62 228 L454 232" stroke="#000" stroke-opacity="0.07" stroke-width="2"/>
    <path d="${upper}" fill="${c.upper}" stroke="#000" stroke-opacity="0.12" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M56 206 C50 170 52 132 66 106 L100 128 C92 158 92 186 98 208 Z" fill="${c.heel}"/>
    <path d="M98 92 C116 95 130 106 144 116 C160 126 180 126 196 116 C206 108 214 92 222 82" fill="none" stroke="#000" stroke-opacity="0.18" stroke-width="5" stroke-linecap="round"/>
    <path d="M404 176 C434 186 452 198 454 214 L408 212 C412 198 410 186 404 176 Z" fill="${c.overlay}" opacity="0.9"/>
    <path d="M110 206 C128 176 168 156 214 150 C240 147 258 160 272 180 C248 190 228 200 218 210 Z" fill="${c.overlay}"/>
    <path d="M120 199 C140 176 176 160 214 156" fill="none" stroke="#fff" stroke-opacity="0.35" stroke-width="1.6" stroke-dasharray="4 4"/>
    <path d="M246 98 C258 120 274 134 300 146" fill="none" stroke="#000" stroke-opacity="0.14" stroke-width="16" stroke-linecap="round"/>
    ${laces}
    <rect x="60" y="90" width="13" height="26" rx="4" fill="${c.accent}"/>
    <path d="M142 200 L162 184 L172 184 L152 200 Z" fill="${c.accent}"/>
  </g>
</svg>`;
}

export const money = (minor: number) =>
  `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
