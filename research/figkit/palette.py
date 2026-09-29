"""Figure palette, distilled from the two reference papers.

Both references (Scaling Agents for Computer Use, arXiv:2510.02250;
WorldMemArena, arXiv:2605.29341) use the same visual grammar:

  * very light tinted fills, never saturated, so embedded screenshots
    stay the brightest thing on the page
  * thin cool-grey strokes, dashed only for *grouping* borders
  * one saturated accent reserved for callouts that carry meaning
    (the task statement, the model's answer) — never for decoration
  * verdict marks in green/red, used sparingly and always paired with a
    word, because reviewers print in greyscale

Tints are indexed by role rather than by colour name so a figure can be
recoloured wholesale without touching layout code.
"""

from __future__ import annotations

INK = "#1F2937"          # primary text
INK_SOFT = "#64748B"      # captions, secondary labels
INK_FAINT = "#94A3B8"     # axis ticks, arrow tails

STROKE = "#C9D4EA"        # standard container border
STROKE_SOFT = "#E2E8F0"   # card border
STROKE_GROUP = "#B8C4DC"  # dashed grouping border

WHITE = "#FFFFFF"
PAPER = "#FBFCFE"

# Stage tints. The reference figures cycle four hues around a loop; the
# order here matches that reading order (observe -> act -> judge -> report).
TINT = {
    "blue":   "#EEF2FB",
    "purple": "#F3EEFB",
    "mint":   "#EAF6F0",
    "peach":  "#FDF1E7",
    "slate":  "#F1F5F9",
}
TINT_EDGE = {
    "blue":   "#AEC0E8",
    "purple": "#C7B4EC",
    "mint":   "#A8D8C0",
    "peach":  "#F0C9A0",
    "slate":  "#CBD5E1",
}
TINT_TEXT = {
    "blue":   "#2F4FA8",
    "purple": "#6D3FBF",
    "mint":   "#15795A",
    "peach":  "#A85F12",
    "slate":  "#475569",
}

ACCENT = "#7C4DE0"        # callout chips (task / answer)
ACCENT_SOFT = "#EDE4FC"

PASS = "#16A34A"
PASS_SOFT = "#DCFCE7"
FAIL = "#DC2626"
FAIL_SOFT = "#FEE2E2"
WARN = "#D97706"
WARN_SOFT = "#FEF3C7"

MONO_BG = "#F8FAFC"
MONO_FG = "#334155"

# Two families only. Reviewers read figures at 80% zoom in a PDF viewer;
# a third family reads as noise.
SANS = "Inter, Helvetica Neue, Helvetica, Arial, sans-serif"
MONO = "SFMono-Regular, Menlo, Consolas, monospace"

# PowerPoint has no web-font fallback chain, so the editable export uses
# the single names below.
SANS_PPT = "Helvetica Neue"
MONO_PPT = "Menlo"
