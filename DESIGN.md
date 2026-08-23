---
name: IWOMC Rescue Console
description: A warm, evidence-first operating console for making a broken checkout runnable from a verified contract.
colors:
  ink-950: "#23150f"
  ink-900: "#2c1b13"
  ink-800: "#3d281f"
  ink-600: "#5c4133"
  ink-400: "#7a5c4b"
  ink-300: "#b39a89"
  sand-100: "#f2e9dc"
  sand-200: "#e9dccc"
  ivory: "#fffaf2"
  paper: "#fffdf9"
  signal: "#b85632"
  signal-deep: "#934123"
  ready: "#396a52"
  attention: "#85571b"
  danger: "#a74032"
  info: "#285f86"
typography:
  interface:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Segoe UI Variable Text, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    lineHeight: 1.55
  page-title:
    fontSize: "34px"
    fontWeight: 660
    letterSpacing: "-0.032em"
  verdict:
    fontSize: "30px"
    fontWeight: 660
    letterSpacing: "-0.03em"
  machine:
    fontFamily: "ui-monospace, SF Mono, Cascadia Mono, Segoe UI Mono, Roboto Mono, Menlo, Consolas, monospace"
    fontSize: "13px"
rounded:
  sm: "10px"
  md: "16px"
  lg: "24px"
spacing:
  compact: "8px"
  control: "12px"
  section: "18px"
  page: "36px"
components:
  action-primary:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.ivory}"
    rounded: "11px"
    height: "40px"
  action-dominant:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.ivory}"
    rounded: "13px"
    height: "50px"
  card:
    backgroundColor: "{colors.ivory}"
    rounded: "{rounded.md}"
  document:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.md}"
  machine-surface:
    backgroundColor: "{colors.ink-950}"
    textColor: "#e7d8c8"
---

# Design system: the Warm Recovery Console

> Recorded from the built surface after the finish round, not before it. Every
> value here is in `apps/console/src/styles.css`.

## The thesis

One question owns the product: **can this checkout be rescued now?** The console
answers it in words, in one panel, with one action beneath it. It refuses the
arrangement this category ships by default — a grid of metric tiles above a
table — because a metric tile cannot answer that question and an evidence
document can.

The visual world is warm and calm on purpose. The person reading this screen is
already frustrated; the interface should not add noise, and it should never
imply progress it has not made.

## Modes and scope

Operate. Familiarity is a feature. Standard navigation, standard controls,
standard form vocabulary, density where density helps. Brand lives in the
signal grid, the contract document, and the single action colour — not in
reinvented affordances.

## Colour

Restrained: warm neutrals plus one accent.

- **Espresso (`ink-*`)** — the navigation rail, machine surfaces, and every
  level of text. `ink-900` for body, `ink-600` for supporting prose, `ink-400`
  for metadata, `ink-300` only on the dark rail.
- **Sand and ivory** — `sand-100` is the application canvas, `ivory` is a raised
  work surface, `paper` is a document surface. Three levels, no more.
- **Terracotta (`signal`)** — reserved for exactly two things: the dominant
  action, and the focus ring. It is never decoration. A screen has one
  `.btn--primary`; the console tests assert that.
- **Sage (`ready`), amber (`attention`), brick (`danger`), slate (`info`)** —
  state only.

Every state colour is paired with a word and a dot shape, so the interface reads
correctly in greyscale and to a screen reader. `ready` is a filled round dot,
`attention` a filled square, `danger` a hollow square.

All text meets WCAG AA against its own composited background; the measured
ratios are `primary action 4.58`, `ready pill 4.50`, `attention pill 5.13`,
`inactive nav link 6.66`, `fact label 5.97`, `verdict reason 8.95`. The state
colours were darkened from their first draft specifically to clear 4.5:1 on
their own tinted washes.

## Typography

One family: the platform's UI sans. Product UI does not need a display pairing,
and a second face here would be costume.

A fixed rem scale, not fluid: 34 / 30 / 22 / 17 / 15 / 14 / 13 / 12 / 11px,
roughly 1.15–1.2 between steps. Users view a tool at a consistent size; a
heading that shrinks inside a panel looks worse, not better.

Monospace is reserved for what it is for: digests, commits, argv, file paths,
identifiers, and machine output. It is never a costume for "technical".

Uppercase is used only for short structural labels — fact keys and section
eyebrows at 11–12px with 0.04–0.08em tracking.

## Layout

- A sticky 248px espresso rail and a warm canvas, content centred at 1200px with
  36px gutters and 44px of top space.
- The Overview is one full-measure verdict panel, then a two-column evidence
  grid at 1.35fr / 1fr: the contract document leads, the device and last-run
  context follow.
- Record indexes are single full-width lists with 74px minimum rows: one primary
  label, one metadata line, a text status, and any action. Long labels truncate
  on one line rather than widening the layout — except where the supporting line
  *is* the substance (`record__meta--wrap`), such as the ecosystem support
  matrix.
- At 900px the rail becomes an off-canvas drawer behind a 60px header, and the
  two-column grids collapse. At 650px gutters drop to 12px and fact lists become
  single-column.

## Depth and shape

Depth is warm, soft, and vertical. One declaration per element: a card carries a
shadow, a document carries a fine border *and* a shadow because it needs a
complete edge. Card shadow is
`0 1px 0 rgba(255,255,255,.85) inset, 0 12px 30px rgba(69,43,29,.07), 0 2px 5px rgba(69,43,29,.05)` —
an offset and a soft blur, never a zero-offset halo.

Radii: 10px controls, 16px cards and documents, 24px the verdict panel. Pills
are fully round; they are small controls.

Machine surfaces invert: espresso ground with an inward shadow.

## The signal grid

IWOMC's mark and its state indicator: four squares standing for the four kinds
of evidence the product can hold about a revision — **declared**, **observed**,
**locally checked**, **clean verified**. A filled square means IWOMC holds that
evidence; each square owns a colour (info, attention, ready, signal).

It appears three ways: as the product mark in the rail, as a legend panel beside
the verdict, and as individual cells in that legend. It is never the only
carrier of meaning — the legend spells out each square in a sentence, and the
grid's accessible name lists what is held.

## The contract document

A contract is rendered as what it is: a signed operational document bound to one
revision. A ruled monospace header carrying the digest, revision, and state; a
body of fact rows; the ordered list of steps a rescue will run; and a signature
line naming who vouched for it and whether a human approved.

It is deliberately not a bug-report card and never a nested card.

## Motion

150–250ms on state transitions, exponential ease-out from an already-visible
default. One spinner, on a button that is genuinely waiting. One skeleton, while
data is genuinely loading. No page-load choreography: a tool loads into a task.

Everything is disabled under `prefers-reduced-motion`.

## Copy

The product's own language, and never more certainty than it has.

- Controls name their action: "Rescue this checkout", "Verify contract",
  "Review a repository repair".
- Errors name the problem and the recovery, always as `<what happened>` plus
  `Next: <one concrete action>`.
- Empty states teach the interface: the first-run panel is the four commands in
  order, not "nothing here".
- Unavailable is stated plainly with the reason and the missing value.
  "memory disconnected" is a real, expected state, not a failure.

## Do

- Pair every state colour with a word and a shape.
- Keep one dominant action per screen.
- Show the digest, the revision, and the signer — a person operating this needs
  identifiers, not reassurance.
- Preserve the 3px terracotta focus ring at 3px offset.
- Say what the UI does not know.

## Don't

- Green because something finished. Green means a proof command passed.
- A metric tile row. This product has no number worth a hero.
- Gradients, glass, glow, or a purple AI aesthetic.
- Nested cards, or a second competing primary action.
- Sample records, staged teammates, or placeholder telemetry. Every screen shows
  persisted data or an honest empty state; `pnpm run honesty` enforces it.
