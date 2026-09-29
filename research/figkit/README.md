# figkit — paper figures that survive review and stay editable

## Two themes

`FIGKIT_THEME=geist` (default) or `lab`.

**geist** is taken from the design tokens of [corespeed.io](https://corespeed.io),
which belongs to the Vercel/Geist lineage: white surfaces on an off-white
canvas, hairline borders (`#EBEBEB`), near-monochrome text, and colour
reserved for three semantic states plus one accent. Structure comes from
alignment and spacing rather than from fills.

This is the better default for a paper figure. Tinting four cascade
layers in four hues asserts that hue means something; in our figures it
did not — it was decoration standing where information should be. And
reviewers print in greyscale, where four tints collapse into four
indistinguishable greys while a hairline layout is unchanged.

| role | geist | meaning |
|---|---|---|
| ink / ink-soft | `#171717` / `#4D4D4D` | everything structural |
| line | `#EBEBEB` | separation |
| accent | `#0070F3` | what is being proposed |
| pass / fail / warn | `#0E8A5F` / `#D40000` / `#A96500` | allow / block / pending, and nothing else |

**lab** is the original: the tinted-region grammar of Xin Eric Wang's
group, [Scaling Agents for Computer Use](https://arxiv.org/abs/2510.02250)
Fig. 3 and [WorldMemArena](https://arxiv.org/abs/2605.29341) Fig. 1–2.
Keep it for venues where that is the house style. Tokens are indexed by
role, so a figure renders in either theme without edits.

Its grammar, distilled:

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

## Two checks that are not optional

**Print size.** A figure designed 1000 units wide and placed at
`\textwidth` renders at about half scale, so a 7-unit label arrives at
3.5pt. The floor is **12 units (~6pt printed)**. Content that does not
fit at that size gets cut, not shrunk.

**Greyscale.** Render `.convert("L")` and look. The semantic colours are
deepened from corespeed's surface values for exactly this reason: at
`#F5A623`, "pending" converts to L≈175 and disappears on a light fill.
The shipped values sit at L=96/63/110 against ink at L=23. Every verdict
also carries a word, because colour alone is never the signal.

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
- **A double quote inside a font stack breaks the SVG.** The stacks are
  interpolated into `font-family="..."`, so `"SF Pro Text"` closes the
  attribute and the file stops parsing at the first `<text>`. Use single
  quotes.
- **`export()` raises on a failed conversion.** It used to swallow the
  error, which left the *previous* PDF/PNG on disk: the build reported
  success, the figure silently did not change, and the stale file is what
  went into the paper. It now deletes the target first and raises.
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
