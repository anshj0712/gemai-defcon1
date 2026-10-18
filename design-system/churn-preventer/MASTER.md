# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/churn-preventer/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** Churn Preventer (merchant dashboard, `apps/dashboard`)
**History** (all 18 Oct 2026):
1. **First pass:** generated with ui-ux-pro-max (`"data-dense analytics operations dashboard" --design-system --density 8 --variance 4 --motion 3`), kept on the original palette.
2. **Taste pass:** a cosmetic rebuild with the taste skills (`redesign-existing-projects`). Its warm "paper and ink" palette was rejected by the product owner ("looks like a chocolate website").
3. **Final:** the original monitoring palette is back. The taste pass's components, type and icons stay.

**Category:** Analytics dashboard, monitoring console
**Design Dials:** Variance 4/10 (Balanced) | Motion 3/10 (Subtle) | Density 8/10 (Dense)
**Implementation:** shadcn/ui (radix base) on Tailwind v4; tokens are CSS variables in `apps/dashboard/src/index.css`

## Direction

A monitoring console for a merchant: issues ranked by revenue at risk, the replay at the flagged moment, agent hypotheses to approve or reject. Dense, easy to scan, calm; the numbers and the merchant's decision carry the page.

- **The original palette (product owner's call).** A navy top bar, a light gray-blue page, white cards, and blue for actions, links and focus. Red, orange, amber and slate mark priority; violet marks the agent; red marks money. Merchants already read these colors.
- **Light is the default.** Dark is opt-in from the theme menu (Light, Dark, Match my system).
- **Color carries meaning only.** Every color sits next to a text label.

### Kept from the taste pass

| Generic pattern | Now |
| --- | --- |
| IBM Plex everywhere | Geist (UI and titles), Geist Mono (selectors, ids, code) |
| Lucide icons | Phosphor (regular weight); the agent's mark is a detective, not sparkles |
| Pill badges, all-caps labels | Square badges (5 px radius), sentence-case labels |
| Solid white-text priority pills (P1 at 3.6:1, P2 at 2.9:1) | A tint of the priority color, its 800-step ink for the text, and a small square mark |
| Symptom chips with colored text | Neutral text with a colored square; the color stays the replay timeline's |
| Dashed borders for hypotheses, side stripes on flagged moments | Solid hairlines (violet for the agent); a mono time tag |
| Card borders plus `shadow-xs`, `shadow-md` hovers | Hairline rings; one soft slate shadow on hover, for linked cards only |
| A cycling sun or moon button | A theme menu |
| rrweb-player's indigo controls | Controls in the palette (blue handle and active speed) |

### Dropped with the warm palette

- The paper grain.
- The Newsreader serif titles; titles are Geist again, which suits a console.
- The charcoal primary button; actions are blue again.

## Color tokens

| Token | Light | Use |
| --- | --- | --- |
| `--topbar`, `--topbar-muted`, `--topbar-active` | #111827, #cbd5e1, #1f2937 | The navy top bar, its links, the mark's tile; the active tab has a blue underline |
| `--background` / `--card` | #f6f7fb / #ffffff | Page / cards and tables |
| `--foreground` / `--muted-foreground` | #111827 / #666d7a | Text / secondary text |
| `--border` / `--input` | #e5e7eb / #d1d5db | Hairlines / fields |
| `--primary`, `--ring`, `--link` | #2563eb | Actions, focus, links, selection |
| `--money`, `--danger-muted`, `--danger-border` | #b91c1c, #fef2f2, #fecaca | Revenue at risk, Fix this first (a 65% tint over the card) |
| `--tier-p0` … `--tier-p3` | #dc2626, #ea580c, #ca8a04, #64748b | Priority marks, bars, dots |
| `--tier-p0-ink` … `--tier-p3-ink` | #991b1b, #9a3412, #854d0e, #334155 | Priority badge text on a 12–14% tint |
| `--agent`, `--agent-muted`, `--agent-border`, `--agent-strong` | #5b21b6, #ede9fe, #a78bfa, #7c3aed | Agent modules, hypotheses, found later, Data rule, the bell count |
| `--kind`, `--kind-muted` | #3730a3, #eef2ff | Element badge |
| `--info*` | #1e40af, #dbeafe, #bfdbfe | Your rules, drafts, evidence chips |
| `--warn*` | #9a3412, #fff7ed, #fed7aa | Churn reason chip |
| `--success*` | #166534, #dcfce7, #22c55e, #16a34a | Approved, live, fixed, the live dot, Visually confirmed (as a tint) |
| `--synthetic*` | #78350f, #fef3c7, #fde68a | Amber notices: the offline stand-in alert, a probe that reads nothing |

**Dark:**
- Slate tones from the first pass: background slate-950, cards slate-900, and lighter steps of the same hues.
- Priority inks are the 300 steps (#fca5a5, #fdba74, #fcd34d, #cbd5e1).
- The bell count is slate-900 on violet.

**Symptoms** (replay timeline and chip marks, `FLAG_COLORS` in markers.ts):
- dead click: red #ef4444;
- rage click: orange #f97316;
- stopped responding: yellow #eab308;
- wrong totals: purple #a855f7;
- errors: pink #ec4899;
- JS errors on the timeline: #db2777.

**Charts** (categorical, stacked issues on Time travel), the dataviz reference palette validated on this chart's surfaces:
- **Light, on #ffffff:** #2a78d6, #eb6834, #1baf7a, #eda100, #e87ba4, #008300.
- **Dark, on slate-900:** #3987e5, #d95926, #199e70, #c98500, #d55181, #008300.

**Contrast:** text pairs are at least 4.5:1 in both themes.
- Priority badges use ink on a tint: 6.0–8.7:1 in light, 7.3–8.5:1 in dark.
- Secondary text moved from #6b7280 to #666d7a, so it passes on the gray fill (4.73:1).

## Typography

- **Families:** `--font-sans` is Geist Variable; `--font-mono` is Geist Mono Variable. Both are self-hosted with @fontsource.
- **Titles:**
  - page titles: 28 px, weight 600, tracking -0.02em;
  - issue titles: 26 px;
  - the brand: 16 px, weight 600.
- **Figures:**
  - hero figures: 52 px, weight 600, tracking -0.03em, tabular;
  - KPI figures: 26–30 px, weight 600.
- **Body:** 14 px, line height 1.55. Descriptions are capped at 68 characters, with `text-wrap: pretty`; headings use `balance`.
- **Labels:** 12.5 px, weight 500, muted, sentence case.
- **Numbers:** tabular figures everywhere.

## Spacing, shape, depth

- **Spacing:** 4, 8, 12, 16, 24, 32 px. Pages start 32 px below the top bar and end with 64 px of air.
- **Radius:** `--radius` is 0.5rem.
  - Cards: 11 px.
  - Buttons: 6 px.
  - Badges: 5 px.
  - Rank numbers and icon chips: 6 px squares.
- **Depth:**
  - cards: a hairline ring and no resting shadow;
  - linked cards: a soft slate shadow on hover (`0 10px 28px -16px rgb(15 23 42 / 0.35)`);
  - the top bar: a thin drop shadow.
- **Layout:** max width 1320 px with 24 px gutters; a sticky navy top bar.

## Components (shadcn)

- **Buttons:** blue primary, outline on the card color, ghost. Press feedback is `scale(0.98)`, and transitions are 200 ms ease-out-expo.
- **Badges:** square, with a tint and ink text. TierBadge adds a 6 px square mark in the priority color.
- **Tabs:**
  - page-level tabs (issue page, Rules) use `PageTabsList`: plain labels on a hairline, the current one underlined;
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
| The active top-bar tab | The blue underline grows from the left (`motion-grow`) | 700 ms |
| A new agent proposal arrives | The bell nudges once and the count pops | 700 ms / 420 ms |
| Hover on a linked card | 1 px lift and a soft shadow | 200 ms |
| A button is pressed | Scales to 0.98 | 200 ms |

Reduced motion means fewer and gentler, not none. Rises, pops, nudges and the pulsing dot go; fades and color changes that carry state stay.

## Accessibility (must)

- **Contrast:** text at least 4.5:1 in both themes.
- **Focus:** a visible blue focus ring on every interactive element.
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
- Warm or brown neutrals, paper textures, serif display titles (tried and rejected on 18 Oct)
- Pill-shaped badges, all-caps labels, colored text on chips
- Dashed borders, side-stripe accents, `shadow-md` and up at rest
- Purple or blue gradients, glassmorphism
- Scroll reveals, and entrance animations that replay on every refresh
- Color-only status

## Pre-delivery checklist

- [ ] One icon family (Phosphor); no emoji
- [ ] Semantic tokens only; no raw colors in components
- [ ] Text contrast ≥ 4.5:1 in light and dark
- [ ] Focus ring visible; full keyboard path through the top bar, issues, Rules actions, dialogs and the theme menu
- [ ] `prefers-reduced-motion` removes movement and keeps fades and color feedback
- [ ] Tables scroll inside their card; no horizontal page scroll at 1280 and 1440
- [ ] No "synthetic" text in the UI; the templated label is visible when the agents run offline
