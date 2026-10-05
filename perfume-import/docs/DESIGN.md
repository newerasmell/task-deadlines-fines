# Design

## What the app is
An internal review tool for 3–6 people who check hundreds of product fields per batch. Primary job: see instantly what needs a human decision, decide fast, upload. It should feel like a precise editing instrument, closer to a spreadsheet than to a marketing dashboard. Density and speed beat decoration.

## Process (mandatory for every screen)
1. Before coding a screen, write a short plan: layout as an ASCII wireframe, which components, what the one emphasis is.
2. Check the plan against the anti-patterns below; revise.
3. Build with real data from the group-1 exports, never lorem ipsum.
4. Screenshot with Playwright at 1440 px and 1024 px, critique against this file, fix, repeat until clean.
5. References of screens the team likes live in `design/references/`; look at them before step 1.

## Tokens
Color (light theme only for v1):
- `ink` #1A1D21 text, `ink-2` #5B6470 secondary text, `line` #E3E6EA borders, `canvas` #FFFFFF, `surface` #F5F6F8 panels
- `accent` #2F5BEA primary actions and focus
- Status (the one bold element of the whole app, used only for status): ok #2E7D4F, suggested #2F5BEA, fixed #B7791F, warning #D9731A, blocked #C62B2B. Cells use a 10% tint background plus a 3 px left bar in the full color; never color text alone.

Type: IBM Plex Sans (covers Cyrillic and Greek), weights 400/500/600. Scale 12 / 13 / 14 / 16 / 20. Grid text 13 px, tabular numbers for prices and counts. Sentence case everywhere.

Spacing: 4 px base; grid row height 36 px; radius 6 px on buttons and inputs, 0 on grid cells; one shadow only, on the side panel.

## Components
shadcn/ui (restyled with the tokens above), TanStack Table with virtualization for the grid, lucide icons at 16 px. No other UI library.

## Layout
```
+-------------------------------------------------------------+
| Batch 2026-09-30 · Group 1   [GR][HR][PL]   filters   Upload |
+---------------------------------------------+---------------+
| grid: product rows × field columns          | field panel   |
| status-tinted cells, sticky first column    | (opens on     |
|                                             |  cell click)  |
+---------------------------------------------+---------------+
| counts: 412 ok · 38 suggested · 6 blocked                    |
+-------------------------------------------------------------+
```

## Anti-patterns (do not do)
- Cards around everything, KPI tiles with big numbers and gradients, hero sections.
- Purple/indigo gradients, glassmorphism, decorative shadows, emoji as icons.
- All-caps eyebrow labels, "→" in buttons, monospace for small labels.
- Fade/slide animations on load; motion only in response to an action (panel open, cell saved).
- Generic copy ("Submit", "Something went wrong"). Buttons say exactly what happens ("Приеми предложението", "Качи 24 продукта в HR"); errors say what is wrong and how to fix it.

## English reference
Every localized value (notes, description, SEO) shows its English reference directly below it: 12 px, color ink-2, prefixed `EN ·`. In the grid it is the second line of the cell; in the product view it sits under each store's value. Never hidden behind a hover.

## Quality floor
Full keyboard use in the grid (arrows, Enter opens panel, A accepts, E edits, Esc closes), visible focus, contrast AA, works at 1024 px width.
