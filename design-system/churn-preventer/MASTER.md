# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/churn-preventer/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** Churn Preventer (merchant dashboard, `apps/dashboard`)
**Generated:** 2026-10-18 00:21 with ui-ux-pro-max (`"data-dense analytics operations dashboard" --design-system --density 8 --variance 4 --motion 3`), then edited to the final direction below
**Category:** Analytics Dashboard, operations console
**Design Dials:** Variance 4/10 (Balanced) | Motion 3/10 (Subtle) | Density 8/10 (Dense)
**Implementation:** shadcn/ui (radix base) on Tailwind v4; tokens are CSS variables in `apps/dashboard/src/index.css`

## Direction

The dashboard is an ops console for a merchant: issues ranked by revenue at risk, the replay at the flagged moment, agent hypotheses to approve or reject.

It should be dense and easy to scan. It should also be calm: the numbers and the merchant's decision carry the page, not decoration.
- **The original palette stays (product owner's call, 18 Oct).** A navy top bar, a light gray-blue page, white cards, and blue for actions. Tier, kind and symptom colors are unchanged, because merchants already read them.
- **The redesign changes components and motion, not colors.**
- **Light is the default.** Dark is opt-in from the top bar (Light, Dark, System).
- Color carries meaning only: tier, agent, money, synthetic, success. Every color sits next to a text label.

### Deviations from the generator

| Generator said | We use | Why |
| --- | --- | --- |
| Pattern "Enterprise Gateway" (hero, solutions, logos, contact sales) | App shell: top bar with tabs, then dense page content | That is a marketing landing pattern; this is a working console. |
| Fira Code headings, Fira Sans body (Google Fonts link) | IBM Plex Sans Variable for the UI, IBM Plex Mono only for selectors, probe names and ids; self-hosted with @fontsource | Monospace headings slow scanning. Plex reads as financial and trustworthy, and it differs from the demo shop's Inter and Oswald, so the two apps never look alike in the video. |
| Foreground `#1E3A8A` (blue-900), border `#DBEAFE` | Slate foreground and borders | Blue body text and blue borders read as links. |
| Amber primary button | Blue primary; amber only for the "synthetic" marker and P2 | Amber CTAs compete with the warning tiers. |
| GSAP scroll reveal | CSS motion that explains change (see Motion), no scroll reveals | Motion on data that is being read hurts scanning, and it would add a dependency. |
| Card hover lift on every card | A 1 px lift and shadow on linked cards only (issue cards, hypotheses); static cards do not move | Feedback says "this opens"; static cards stay still. |
| The generator's blue-900 and amber palette | The dashboard's original colors | Product owner's call: the existing colors are what merchants already understand. |

## Color tokens

The dashboard's original colors, exposed as shadcn semantic variables (`:root` for light, `.dark` opt-in) in `apps/dashboard/src/index.css`. Components use tokens only.

| Token | Light (original) | Use |
| --- | --- | --- |
| `--topbar`, `--topbar-muted`, `--topbar-active` | #111827, #cbd5e1, #1f2937 | The navy top bar, its links, the active tab |
| `--background` / `--card` | #f6f7fb / #ffffff | Page / cards, tables |
| `--foreground` / `--muted-foreground` | #111827 / #6b7280 | Text / secondary text |
| `--border` / `--input` | #e5e7eb / #d1d5db | Dividers / fields |
| `--primary` / `--ring` | #2563eb | Actions, links, focus ring, the active-tab underline |
| `--money`, `--danger-muted`, `--danger-border` | #b91c1c, #fef2f2, #fecaca | Revenue at risk, the revenue card, captions, Fix this first |
| `--tier-p0` … `--tier-p3` | #dc2626, #ea580c, #ca8a04, #64748b (white text) | Tier pills; also the visual-check badges |
| `--kind`, `--kind-muted` | #3730a3, #eef2ff | ELEMENT badge |
| `--agent`, `--agent-muted`, `--agent-border`, `--agent-strong` | #5b21b6, #ede9fe, #a78bfa, #7c3aed | DATA RULE badge, hypotheses (dashed), found later, the bell count, the time-travel slider |
| `--synthetic`, `--synthetic-muted`, `--synthetic-border` | #78350f, #fef3c7, #fde68a | Amber notices: the offline stand-in alert, a probe that reads nothing (no synthetic markers since 18 Oct) |
| `--warn`, `--warn-muted`, `--warn-border` | #9a3412, #fff7ed, #fed7aa | Churn reason chip |
| `--success`, `--success-muted`, `--success-strong`, `--success-solid` | #166534, #dcfce7, #22c55e, #16a34a | Approved, live, fixed; the live dot; Visually confirmed |
| `--info`, `--info-muted`, `--info-border` | #1e40af, #dbeafe, #bfdbfe | Drafts, evidence chips |

Symptom chips keep the replay timeline's flag colors (`FLAG_COLORS` in markers.ts) as their outline and text.

Contrast note: the original palette is kept as is. Four pairs sit below 4.5:1, all of them already in the dashboard before the redesign:
- white on the P1 orange pill, about 3.6:1;
- white on the P2 amber pill, about 2.9:1;
- white on the green "Visually confirmed" badge, about 3.3:1;
- gray-500 secondary text on the gray-100 fill, about 4.4:1.

Darkening those three fills one step (orange-700, amber-700, green-700) would pass. Change them only if the product owner agrees.

## Typography

- **Families:** `--font-sans` is "IBM Plex Sans Variable"; `--font-mono` is "IBM Plex Mono" (400, 500).
- **Scale (px):** 12 labels and badges, 13 secondary, 14 body, 16 card titles, 20 section titles, 24 page title, 36 revenue hero.
  - Body is 14 px with 1.5 line height: a desktop console, dense on purpose.
- **Weights:** 400 body, 500 labels, 600 titles, 700 big numbers.
- **Numbers:** `font-variant-numeric: tabular-nums` (`tabular-nums`) on every number, price and time.
- **Small caps labels:** uppercase, 12 px, letter-spacing 0.04em, muted.

## Spacing, shape, depth

- **Spacing:** 2, 4, 8, 12, 16, 24, 32 px (density 8). Card padding 12–16 px; table rows 36 px; grid gap 8–12 px.
- **Radius:** `--radius` 0.625rem (cards 14 px). Pills are fully rounded.
- **Depth:** a 1 px border plus `shadow-xs` on cards; overlays (Dialog, Sheet, Sonner) use shadcn defaults. No glass, blur or gradients.
- **Layout:** max content width 1320 px with 24 px gutters. Sticky top bar; tables have sticky headers and scroll horizontally inside their card on narrow screens.

## Components (shadcn)

- **Buttons:** Button (default, outline, ghost, destructive; sizes sm and default). One primary action per card, for example "Approve probe and rule".
- **Labels:** Badge for tier, kind, source, status and "Hypothesis · not a finding yet". A Badge always shows text.
- **Containers and tables:** Card for tiles, issues, hypotheses and rules. Table for signals, dry runs, evidence and probes.
- **Overlays:**
  - Tabs inside a section, such as probe sources;
  - Dialog for "Change the rule" and "Not a problem";
  - Sheet for the bug switches;
  - Tooltip for icon-only buttons (bell, theme).
- **Feedback:** Skeleton while loading; Sonner for the inbox toast (auto-dismiss, a "Review" action, polite live region).
- **Icons:** lucide-react, 16 px, stroke 2. Decorative icons are `aria-hidden`; icon-only buttons have an accessible name.

## Motion

Thesis (from Impeccable's animate guide, Operate mode): motion explains change in a working tool and never makes the reader wait. One easing, `--ease-out-expo` (cubic-bezier(0.16, 1, 0.3, 1)); exits are shorter than entrances.

| Moment | Motion | Duration |
| --- | --- | --- |
| A page arrives (route change) | Fade and 6 px rise (`motion-enter`) | 260 ms |
| The issue list first appears | The same, staggered 35 ms per card, capped at 8 | ≤ 540 ms in total |
| A live number changes (KPI tiles, card counts, revenue) | Rolls from the old value to the new (`AnimatedNumber`, exponential ease-out) | 700–900 ms |
| A card gains signals | The existing background flash | 1.6 s |
| A section opens (Details, Show evidence, folds, tabs, Add a probe) | Fade and clip from the top (`motion-reveal`) | 220 ms |
| Juror scores appear | Bars grow from the left (`motion-grow`) | 700 ms |
| A new agent proposal arrives | The bell nudges once and the count pops; the toast slides in | 700 ms / 420 ms |
| Hover on a linked card | 1 px lift and shadow; the chevron moves 2 px | 200 ms |
| Theme switch | The icon pops in | 420 ms |

Reduced motion means fewer and gentler, not none. Rises, pops, nudges and the pulsing dot go; fades, color changes and the flash that carries state stay.

## Accessibility (must)

- **Contrast:** text at least 4.5:1 in both themes, checked separately for light and dark, except the four original-palette pairs under Color tokens.
- **Focus:** a visible focus ring on every interactive element, never removed.
- **Keyboard:**
  - full keyboard use;
  - a skip link to the main content;
  - Escape closes Dialog and Sheet;
  - focus returns to the trigger.
- **Not color alone:** tiers, states and verdicts always carry text.
- **Announcements:** the inbox count is announced as a full phrase ("3 agent proposals to review") in one status region.
- **Synthetic labels:** none in the UI since 18 Oct; the writeup and the video say the demo data is synthetic (AGENTS rule 10). The offline stand-in's "templated" label stays: it says what wrote the text, not where the data came from.

## Anti-patterns (do not use)

- Emoji as icons
- Raw hex or `bg-blue-500`-style palette classes in components
- `dark:` overrides (the only ones are where a shadcn variant's own `dark:` hover has to be matched in the navy top bar)
- Layout-shifting hovers
- Scroll reveals, and entrance animations that replay on every refresh
- Glassmorphism
- Monospace headings
- Low-contrast gray-on-gray text
- Color-only status

## Pre-delivery checklist

- [ ] No emoji icons; one icon family (lucide)
- [ ] Semantic tokens only; no raw colors in components
- [ ] Text contrast ≥ 4.5:1, except the four original-palette pairs noted under Color tokens
- [ ] Focus ring visible; full keyboard path through the top bar, issues, Rules actions, Dialog and Sheet
- [ ] `prefers-reduced-motion` removes movement and keeps fades and color feedback
- [ ] Hover states 150–200 ms; disabled states clear
- [ ] Tables scroll inside their card; no horizontal page scroll at 1280 and 1440
- [ ] No "synthetic" text in the UI; the templated label is visible when the agents run offline
