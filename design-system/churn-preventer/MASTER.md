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
- Light and dark themes, following the system setting by default, with a toggle.
- Neutral slate surfaces and one blue for actions.
- Color carries meaning only: tier, agent, money, synthetic, success. Every color sits next to a text label.

### Deviations from the generator

| Generator said | We use | Why |
| --- | --- | --- |
| Pattern "Enterprise Gateway" (hero, solutions, logos, contact sales) | App shell: top bar with tabs, then dense page content | That is a marketing landing pattern; this is a working console. |
| Fira Code headings, Fira Sans body (Google Fonts link) | IBM Plex Sans Variable for the UI, IBM Plex Mono only for selectors, probe names and ids; self-hosted with @fontsource | Monospace headings slow scanning. Plex reads as financial and trustworthy, and it differs from the demo shop's Inter and Oswald, so the two apps never look alike in the video. |
| Foreground `#1E3A8A` (blue-900), border `#DBEAFE` | Slate foreground and borders | Blue body text and blue borders read as links. |
| Amber primary button | Blue primary; amber only for the "synthetic" marker and P2 | Amber CTAs compete with the warning tiers. |
| GSAP scroll reveal | No entrance animation; 150–200 ms state transitions, the card flash on new signals and the live dot only | Motion on data that is being read hurts scanning, and it would add a dependency. |
| Card hover lift (`translateY`) and `cursor: pointer` on every card | Border-color change on hover for linked cards only | Calm; keeps hover from implying that static cards can be clicked. |

## Color tokens

shadcn semantic variables (OKLCH, values from the Tailwind v4 palette) in `:root` and `.dark`. Components use tokens only: no raw colors and no `dark:` overrides.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--background` | slate-50 | slate-950 | Page |
| `--foreground` | slate-900 | slate-50 | Body text (17.6:1 / 19:1) |
| `--card` | white | slate-900 | Cards, tables |
| `--muted` | slate-100 | slate-800 | Quiet fills, table header |
| `--muted-foreground` | slate-600 | slate-400 | Secondary text (7.6:1 on white / 7.0:1 on slate-900) |
| `--border`, `--input` | slate-200, slate-300 | white 10%, white 15% | Dividers, fields |
| `--primary` | blue-700 | blue-400 | Primary action (white text 6.7:1 / slate-950 text 7.9:1) |
| `--ring` | blue-600 | blue-400 | Focus ring, 2 px plus offset |
| `--destructive` | red-700 | red-400 | Errors, destructive actions |
| `--money` | red-700 | red-400 | Revenue at risk (6.5:1 / 6.2:1) |
| `--tier-p0` / `p1` / `p2` / `p3` | red-700 / orange-700 / amber-700 / slate-600 | same | Tier pill fill, white text (≥5.0:1) |
| `--agent`, `--agent-muted` | violet-700, violet-50 | violet-300, violet-950 | Agent hypotheses, agent drafts, found later (dashed border = not a finding yet) |
| `--synthetic`, `--synthetic-muted` | amber-900, amber-100 | amber-200, amber-950 | "Synthetic data" markers (AGENTS rule 10) |
| `--success`, `--success-muted` | green-800, green-50 | green-300, green-950 | Done, approved, fixed |

## Typography

- **Families:** `--font-sans` is "IBM Plex Sans Variable"; `--font-mono` is "IBM Plex Mono" (400, 500).
- **Scale (px):** 12 labels and badges, 13 secondary, 14 body, 16 card titles, 20 section titles, 24 page title, 36 revenue hero.
  - Body is 14 px with 1.5 line height: a desktop console, dense on purpose.
- **Weights:** 400 body, 500 labels, 600 titles, 700 big numbers.
- **Numbers:** `font-variant-numeric: tabular-nums` (`tabular-nums`) on every number, price and time.
- **Small caps labels:** uppercase, 12 px, letter-spacing 0.04em, muted.

## Spacing, shape, depth

- **Spacing:** 2, 4, 8, 12, 16, 24, 32 px (density 8). Card padding 12–16 px; table rows 36 px; grid gap 8–12 px.
- **Radius:** `--radius` 0.5rem. Pills are fully rounded.
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

- **Duration:** 150–200 ms for color, border and opacity transitions, with ease-out.
- **Allowed animations:** only the issue-card flash when it gains signals and the live dot.
- **Reduced motion:** under `prefers-reduced-motion: reduce`, all animation and transition durations go to 0.

## Accessibility (must)

- **Contrast:** text at least 4.5:1 in both themes, checked separately for light and dark.
- **Focus:** a visible focus ring on every interactive element, never removed.
- **Keyboard:**
  - full keyboard use;
  - a skip link to the main content;
  - Escape closes Dialog and Sheet;
  - focus returns to the trigger.
- **Not color alone:** tiers, states and verdicts always carry text.
- **Announcements:** the inbox count is announced as a full phrase ("3 agent proposals to review") in one status region.
- **Synthetic labels:** the "Synthetic data" pill, the offline stand-in's "templated" label and the "synthetic" markers on revenue stay visible (AGENTS rule 10).

## Anti-patterns (do not use)

- Emoji as icons
- Raw hex or `bg-blue-500`-style palette classes in components
- `dark:` overrides
- Layout-shifting hovers
- Entrance or scroll animations on data
- Glassmorphism
- Monospace headings
- Low-contrast gray-on-gray text
- Color-only status

## Pre-delivery checklist

- [ ] No emoji icons; one icon family (lucide)
- [ ] Semantic tokens only; no raw colors in components
- [ ] Text contrast ≥ 4.5:1 in light and in dark
- [ ] Focus ring visible; full keyboard path through the top bar, issues, Rules actions, Dialog and Sheet
- [ ] `prefers-reduced-motion` stops the flash, live dot and transitions
- [ ] Hover states 150–200 ms; disabled states clear
- [ ] Tables scroll inside their card; no horizontal page scroll at 1280 and 1440
- [ ] Synthetic markers and the templated label visible
