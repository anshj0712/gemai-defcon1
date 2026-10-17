# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/churn-preventer/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** Churn Preventer (merchant dashboard, `apps/dashboard`)
**History:**
- 18 Oct 2026, first pass: generated with ui-ux-pro-max (`"data-dense analytics operations dashboard" --design-system --density 8 --variance 4 --motion 3`), kept on the original palette.
- 18 Oct 2026, second pass: rebuilt cosmetically with the taste skills (`redesign-existing-projects`, direction from `minimalist-ui`). The layout and UX were not changed.
**Category:** Analytics dashboard, operations console
**Design Dials:** Variance 4/10 (Balanced) | Motion 3/10 (Subtle) | Density 7/10 (Dense, with air)
**Implementation:** shadcn/ui (radix base) on Tailwind v4; tokens are CSS variables in `apps/dashboard/src/index.css`

## Direction

A merchant's working document, not a SaaS template. The page is warm paper with ink: numbers and decisions carry it, and color is scarce.

- **Paper and ink.** The canvas is a warm off-white (#f7f6f3) with a faint grain. Cards are white with a hairline border and no shadow. Text is warm off-black, never pure black.
- **One accent.** Ink blue (#3d6fa8 focus and chart, #2f5f96 links and info) is the only hue without a business meaning. Primary buttons are charcoal.
- **Quiet meanings.** Priority, revenue, the agent and success keep their colors from the first pass, desaturated:
  - priority: brick, rust, ochre, stone;
  - revenue: brick;
  - the agent: dusty violet;
  - success: sage.
  The product owner chose this on 18 Oct ("Calm the palette too").
- **Editorial type.** Page titles and the brand are set in a reading serif (Newsreader). Everything else is Geist; selectors, ids and code are Geist Mono.
- **Light is the default.** Dark is a warm charcoal, opt-in from the theme menu (Light, Dark, Match my system).

### What the taste pass removed

| Generic pattern | Replaced with |
| --- | --- |
| Navy top bar on a light page (a dark band on a light page) | A light, translucent top bar with a hairline; text tabs with an ink underline |
| Blue primary buttons, blue and violet everywhere | Charcoal primary buttons; ink blue only for links, focus and info |
| IBM Plex everywhere | Geist (UI), Geist Mono (code), Newsreader (page titles, brand) |
| Lucide icons | Phosphor (regular weight); the agent's mark is a detective, not sparkles |
| Pill badges, all-caps labels | Square badges (5 px radius), sentence-case labels |
| Solid white-text priority pills (P1 at 3.6:1, P2 at 2.9:1) | A tint of the priority color, its darker ink for text, and a small square mark |
| Symptom chips with colored text | Ink text with a colored square; the color stays the replay timeline's |
| Dashed borders for hypotheses, side stripes on flagged moments | Solid hairlines (violet for the agent); a mono time tag |
| Card borders plus `shadow-xs`, `shadow-md` hovers | Hairline rings; one soft, warm-tinted shadow on hover for linked cards only |
| A sun or moon toggle | A theme menu |
| rrweb-player's indigo controls | Controls in the palette (charcoal handle, ink progress) |

## Color tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--background` / `--card` | #f7f6f3 / #ffffff | #131211 / #1c1b19 | Page / cards and tables |
| `--foreground` / `--muted-foreground` | #1f1e1c / #6b6862 | #ebe8e3 / #a39f97 | Text / secondary text |
| `--border` / `--input` | #e7e4de / #d9d5cd | white 8% / 14% | Hairlines / fields |
| `--primary` | #1f1e1c | #ebe8e3 | Primary buttons, the active tab underline |
| `--ring` / `--link` | #3d6fa8 / #2f5f96 | #7fa6d6 / #8fb2dc | Focus, selection, caret / links |
| `--topbar*` | the page color at 85% with blur | the same | Top bar |
| `--money`, `--danger-muted`, `--danger-border` | #a3362c, #f8ebe8, #ecccc6 | #e58a7f, #2b1a17, #5a2f29 | Revenue at risk, Fix this first (a 65% tint over the card) |
| `--tier-p0` … `--tier-p3` | #b13d34, #c0662f, #b98a26, #8a867e | one step lighter | Priority marks, bars and dots |
| `--tier-p0-ink` … `--tier-p3-ink` | #922f27, #8f4517, #77560e, #55524c | #f0aaa2, #f0b88f, #e6c57e, #c9c5bd | Priority badge text on a 12–14% tint |
| `--agent`, `--agent-muted`, `--agent-border`, `--agent-strong` | #5a4a8a, #efecf5, #cdc5e2, #7564a8 | #b9abe0, #251f33, #4a4068, #9a88cf | Agent modules, hypotheses, found later, Data rule, the bell count |
| `--kind`, `--kind-muted` | #4a5468, #eceef1 | #b7bfcf, #23262c | Element badge |
| `--info`, `--info-muted`, `--info-border` | #2f5f96, #e8eef5, #c7d5e6 | #8fb2dc, #1b2533, #2f4561 | Your rules, drafts, evidence chips |
| `--warn*` | #8a4512, #f8eee2, #ebd2b3 | #e2b27a, #2b2117, #5a4428 | Churn reason chip |
| `--success*` | #2d6a3e, #e6efe6, #4f9a66, #3c7d50 | #9ccba8, #1b2820, #67ad7d, #3c7d50 | Approved, live, fixed, the live dot |
| `--synthetic*` | #6b4c12, #f6eedb, #e6d4a8 | #e3cc8e, #2a2416, #574a26 | Amber notices: the offline stand-in alert, a probe that reads nothing |

**Symptoms** (replay timeline and chips, `FLAG_COLORS` in markers.ts):
- dead click: brick #b13d34;
- rage click: rust #c0662f;
- stopped responding: ochre #b98a26;
- wrong totals: violet #7564a8;
- errors: rose #b5628a;
- JS errors on the timeline: #9c4a72.

**Charts** (categorical, stacked issues on Time travel), each slot validated with the dataviz checker on its surface:
- **Light, on #ffffff:** #3d6fa8, #c4663a, #1f9479, #c29530, #b5628a, #62801f.
- **Dark, on #1c1b19:** #5f8fc9, #d27a4c, #2fa587, #b08530, #c9739b, #7a9b31.
- **Checks:** the lightness band, chroma floor, adjacent CVD and normal-vision gates all pass.
- **One warning:** the light ochre is 2.75:1 against white. The legend, tooltip and the issue lists below the chart relieve it.

**Contrast:** text pairs are at least 4.5:1 in both themes. That includes the priority badges, which now use ink on a tint and no longer white on a fill.

## Typography

- **Families:**
  - `--font-sans` is Geist Variable;
  - `--font-mono` is Geist Mono Variable;
  - `--font-display` is Newsreader Variable (optical sizes).
  - All are self-hosted with @fontsource.
- **Page titles:** Newsreader 34 px, weight 500, line height 1.08, tracking -0.022em. Issue titles are 30 px. The brand is 19 px, weight 600.
- **Hero figures:** Geist 52 px, weight 600, tracking -0.03em, tabular. KPI figures are 26–30 px, weight 600, tracking -0.02em.
- **Body:** 14 px, line height 1.55. Descriptions are capped at 68 characters, with `text-wrap: pretty`; headings use `balance`.
- **Labels:** 12.5 px, weight 500, muted, sentence case. No all-caps labels.
- **Numbers:** tabular figures everywhere.

## Spacing, shape, depth

- **Spacing:** 4, 8, 12, 16, 24, 32 px. Pages start 32 px below the top bar and end with 64 px of air.
- **Radius:** `--radius` is 0.5rem.
  - Cards: 11 px.
  - Buttons: 6 px.
  - Badges: 5 px.
  - Rank numbers and icon chips: 6 px squares, not circles.
- **Depth:** a hairline ring on cards, and no resting shadow. Linked cards get one soft shadow on hover, tinted warm (`0 10px 28px -16px rgb(31 30 28 / 0.35)`).
- **Texture:** a fixed, pointer-events-free SVG grain at 3.5% (light) or 5% (dark), behind everything and on the canvas only.
- **Layout:** max width 1320 px with 24 px gutters; a sticky, translucent top bar.

## Components (shadcn)

- **Buttons:**
  - charcoal primary;
  - outline on the card color;
  - ghost.
  - Press feedback is `scale(0.98)`, transitions are 200 ms ease-out-expo.
- **Badges:** square, with a tint and ink text. TierBadge adds a 6 px square mark in the priority color.
- **Tabs:**
  - page-level tabs (issue page, Rules) are `PageTabsList`: plain labels on a hairline, the current one underlined;
  - sub-tabs (probe sources) keep the segmented list.
- **Theme:** a DropdownMenu with Light, Dark and "Match my system".
- **Icons:** `@phosphor-icons/react`, regular weight, 16 px. Decorative icons are `aria-hidden`; icon-only buttons have an accessible name.
- **Dialog** handles "Change the rule", "Not a problem" and "Write a rule"; **Sonner** shows toasts; **Skeleton** shows while loading.

## Motion

Thesis (from Impeccable's animate guide, Operate mode): motion explains change in a working tool and never makes the reader wait. One easing, `--ease-out-expo` (cubic-bezier(0.16, 1, 0.3, 1)); exits are shorter than entrances.

| Moment | Motion | Duration |
| --- | --- | --- |
| A page arrives (route change) | Fade and 6 px rise (`motion-enter`) | 260 ms |
| The issue list first appears | The same, staggered 35 ms per row, capped at 8 | ≤ 540 ms in total |
| A live number changes | Rolls from the old value to the new (`AnimatedNumber`) | 700–900 ms |
| A row gains signals | A background flash | 1.6 s |
| A section opens (details, folds, tabs) | Fade and clip from the top (`motion-reveal`) | 220 ms |
| The active top-bar tab | The underline grows from the left (`motion-grow`) | 700 ms |
| A new agent proposal arrives | The bell nudges once and the count pops | 700 ms / 420 ms |
| Hover on a linked card | 1 px lift and a soft shadow | 200 ms |
| A button is pressed | Scales to 0.98 | 200 ms |

Reduced motion means fewer and gentler, not none. Rises, pops, nudges and the pulsing dot go; fades and color changes that carry state stay.

## Accessibility (must)

- **Contrast:** text at least 4.5:1 in both themes.
- **Focus:** a visible ink-blue focus ring on every interactive element.
- **Keyboard:**
  - full keyboard use;
  - a skip link;
  - Escape closes Dialog and menus;
  - focus returns to the trigger.
- **Not color alone:** priority, symptoms, states and verdicts always carry text next to their color.
- **Announcements:** the inbox count is announced as a full phrase in one status region.
- **Synthetic labels:** none in the UI since 18 Oct; the writeup and the video say the demo data is synthetic (AGENTS rule 10). The offline stand-in's "templated" label stays: it says what wrote the text, not where the data came from.

## Anti-patterns (do not use)

- Emoji as icons; Lucide, or mixed icon families
- Raw hex or `bg-blue-500`-style palette classes in components (the exceptions are replay overlays and chart series, which document their values here)
- Pure black or pure white text on the canvas; cool grays (the grays are warm)
- Dark bands on a light page
- Pill-shaped badges, all-caps labels, colored text on chips
- Dashed borders, side-stripe accents, `shadow-md` and up at rest
- Purple or blue gradients, glassmorphism beyond the sticky top bar's blur
- Scroll reveals, and entrance animations that replay on every refresh
- Color-only status

## Pre-delivery checklist

- [ ] One icon family (Phosphor); no emoji
- [ ] Semantic tokens only; no raw colors in components
- [ ] Text contrast ≥ 4.5:1 in light and dark
- [ ] Page titles in Newsreader; everything else Geist; code in Geist Mono
- [ ] Focus ring visible; full keyboard path through the top bar, issues, Rules actions, dialogs and the theme menu
- [ ] `prefers-reduced-motion` removes movement and keeps fades and color feedback
- [ ] Tables scroll inside their card; no horizontal page scroll at 1280 and 1440
- [ ] No "synthetic" text in the UI; the templated label is visible when the agents run offline
