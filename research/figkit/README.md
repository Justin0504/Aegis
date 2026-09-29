# figkit — paper figures that survive review and stay editable

Reference standard: Xin Eric Wang's group, [Scaling Agents for Computer
Use](https://arxiv.org/abs/2510.02250) Fig. 3 and
[WorldMemArena](https://arxiv.org/abs/2605.29341) Fig. 1–2. Their visual
grammar, distilled:

| | |
|---|---|
| fills | very light tints, never saturated, so embedded screenshots stay the brightest thing on the page |
| strokes | thin cool grey; **dashed means grouping**, solid means a thing |
| accent | exactly one saturated colour, reserved for content that carries meaning (task statement, emitted action, verdict) |
| structure | lettered panels `(a) (b) (c)`, each a rounded container |
| evidence | real screenshots, annotated in place, never redrawn |
| verdicts | ✅/❌ **always paired with a word** — reviewers print greyscale |

## The four-step workflow

```bash
python -m tools.figures.fig1_pipeline     # → out/fig1_pipeline.{svg,pdf,pptx,png}
python -m tools.figures.fig2_overlay
```

**1 — Icons first, before any layout.** `figkit/icons.py` pulls from
Iconify and caches under `assets/icons/`. Composing against a fixed set
is most of what makes a paper's figures look like one person drew them.

> **Not Flaticon.** Its free tier requires visible attribution *inside
> the work*, which is awkward in a paper PDF. Iconify serves the same
> icons from MIT / Apache-2.0 / CC0 sets. `icons.py` enforces an
> allowlist, so an attribution-encumbered set cannot reach a figure by
> accident.

Colour is baked in at fetch time, not at render time: an SVG whose stroke
is set by a parent CSS rule renders correctly in a browser and
incorrectly in half the PDF toolchain, silently.

`prefetch()` runs before layout so a typo fails loudly instead of
rendering an invisible gap.

**2 — Describe the figure as shapes, once.** `figkit/scene.py` is a small
scene graph (`Box`, `Text`, `Icon`, `Image`, `Arrow`) plus composites
matching the reference grammar: `panel`, `card`, `chip`, `code`,
`verdict`. Coordinates are points, origin top-left, shared by both
renderers: 1 unit = 1 SVG user unit = 1/72 inch in PowerPoint.

**3 — Render twice.** SVG → PDF for LaTeX; PPTX for hand-editing.

> The obvious route — draw an SVG, drop it into PowerPoint — gives you a
> picture. "Convert to Shape" then explodes it into hundreds of ungrouped
> paths: every rounded rectangle becomes an outline, every text run
> becomes curves. Editable the way a photograph of a whiteboard is.
>
> So the PPTX export emits **native** objects instead. Figure 1 is 79
> shapes: 43 real text boxes you can retype, 23 rounded rectangles with
> live fill/line properties and a working corner-radius handle, 2
> connectors, 11 icon images. Only icons and screenshots are pictures,
> because they are.

**4 — Hand-edit in PowerPoint, then re-export or keep.** If a tweak is
structural, change the script and rebuild. If it is a one-off nudge for
camera-ready, do it in the PPTX and export the PDF from there.

## Gotchas already paid for

- Iconify returns **403** to urllib's default User-Agent. Not 404 — if
  you only check for an SVG body it looks like a missing icon.
- `rsvg-convert` and most PDF toolchains **refuse `file://` hrefs**, and
  fail silently: you get a correctly-sized blank rectangle where the
  screenshot should be. Images are inlined as base64, which also makes
  the `.svg` self-contained for handing to a co-author.
- PowerPoint stores corner radius as a **fraction of the short side**, so
  a fixed-pt radius has to be converted per shape or small boxes come out
  as lozenges.
- Figures are committed with their `assets/`. A build must work offline
  and produce the same bytes next year; a figure that changes because an
  upstream icon set was updated is one you cannot trust in a camera-ready.

## Adding a figure

```python
from tools.figkit.scene import Scene, export
from tools.figkit.icons import prefetch

ICONS = {"bug": "tabler:bug"}          # fails loudly if wrong

def build():
    sc = Scene(980, 320)
    sc.panel(14, 34, 300, 240, "(a)  Setup", tint="mint")
    sc.card(28, 62, 270, 34, "Clean-room browser game", icon=ICONS["bug"])
    sc.code(28, 104, 270, 22, "negative.patch")
    sc.verdict(28, 150, ok=False, label="code-only fails 0/3")
    return sc

prefetch(ICONS); export(build(), Path("out/fig3"), png=True)
```

Tints: `blue purple mint peach slate`. Use `dashed=True` on a panel only
when it groups other panels.
