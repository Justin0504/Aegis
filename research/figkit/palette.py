"""Figure palette, with two themes.

    FIGKIT_THEME=geist   (default)   near-monochrome, colour only where it
                                     carries information
    FIGKIT_THEME=lab                 the tinted-region style of the
                                     reference agent-security papers

WHY THERE ARE TWO

The first version of this file distilled the visual grammar of
arXiv:2510.02250 and arXiv:2605.29341: every stage is a tinted region,
and the tints carry the structure. It works, and it is what a reader of
that literature expects.

The `geist` theme is taken from the design tokens of corespeed.io, which
belongs to the Vercel/Geist lineage, and it inverts that choice. Surfaces
are white on an off-white canvas, separated by hairlines rather than
fills; the entire palette is greyscale except for three semantic colours
and one accent. Structure comes from alignment and spacing, and colour is
spent only where it is doing work.

For a paper figure that is the better trade, for two reasons. Tinting
four cascade layers in four hues asserts that the hue means something,
and in our figures it did not --- it was decoration standing where
information should be. And reviewers print in greyscale, where a
four-tint layout collapses into four indistinguishable greys while a
hairline layout is unchanged.

Tokens are indexed by role, not by colour name, so a figure written
against one theme renders in the other without edits.
"""

from __future__ import annotations

import os

THEME = os.environ.get("FIGKIT_THEME", "geist").lower()

# Two families only. Reviewers read figures at 80% zoom in a PDF viewer;
# a third family reads as noise. Geist is the reference face; the stack
# degrades to the system UI font, which is what corespeed.io itself falls
# back to and is close in proportion.
# Single quotes, not double: these strings are interpolated into an XML
# attribute (font-family="..."), and a double quote inside closes it early,
# producing an SVG that parses as far as the first <text> and no further.
SANS = ("Geist, Inter, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, "
        "sans-serif")
MONO = "'Geist Mono', 'SFMono-Regular', Menlo, Consolas, monospace"
SANS_PPT = "Helvetica Neue"
MONO_PPT = "Menlo"

if THEME == "geist":
    # ---- corespeed.io home tokens ---------------------------------------
    PAPER = "#FAFAFA"        # --home-canvas
    WHITE = "#FFFFFF"        # --home-surface
    INK = "#171717"          # --home-ink
    INK_SOFT = "#4D4D4D"     # --home-body
    INK_FAINT = "#8A8A8A"    # between --home-muted and --home-line-strong

    STROKE = "#EBEBEB"       # --home-line
    STROKE_SOFT = "#F0F0F0"  # between --home-hairline and --home-line
    STROKE_GROUP = "#D8D8D8" # a grouping border has to read as deliberate

    ACCENT = "#0070F3"       # --home-accent
    ACCENT_SOFT = "#D3E5FF"  # --home-accent-soft

    # Deepened from --chart-series-3 (#1BAF7A) and --home-warning
    # (#F5A623). Those are surface colours; used as text or as a 2px line
    # they convert to L~150 and L~175 in greyscale and vanish on a light
    # fill. corespeed.io makes the same move for its accent
    # (--home-accent-strong #0761D1), so a deeper pair is in keeping. The
    # soft fills are unchanged --- they are backgrounds, and they carry a
    # word on top of them either way.
    PASS = "#0E8A5F"
    PASS_SOFT = "#D7F2E7"
    FAIL = "#D40000"         # --home-error, a shade down
    FAIL_SOFT = "#FFE3E3"
    WARN = "#A96500"
    WARN_SOFT = "#FFEFCF"

    MONO_BG = "#FAFAFA"
    MONO_FG = "#4D4D4D"

    # Every region is the same white card. Identity comes from its label,
    # not its fill, which is the whole point of this theme --- so a figure
    # that used tints purely to separate panels loses nothing, and one
    # that used them to mean something has to say so in words instead.
    _SURFACE = "#FFFFFF"
    TINT = {k: _SURFACE for k in ("blue", "purple", "mint", "peach", "slate")}
    TINT["slate"] = "#FAFAFA"          # the one grouping surface
    TINT_EDGE = {k: "#EBEBEB" for k in TINT}
    # No region carries colour through its label either. The discipline this
    # theme enforces is that green/red/amber mean allow/block/pending and
    # nothing else, and the accent marks what is being proposed -- so a
    # panel title has no claim on any of them.
    TINT_TEXT = {k: INK for k in TINT}

else:
    # ---- the tinted-region style of the reference papers -----------------
    INK = "#1F2937"
    INK_SOFT = "#64748B"
    INK_FAINT = "#94A3B8"

    STROKE = "#C9D4EA"
    STROKE_SOFT = "#E2E8F0"
    STROKE_GROUP = "#B8C4DC"

    WHITE = "#FFFFFF"
    PAPER = "#FBFCFE"

    TINT = {
        "blue": "#EEF2FB", "purple": "#F3EEFB", "mint": "#EAF6F0",
        "peach": "#FDF1E7", "slate": "#F1F5F9",
    }
    TINT_EDGE = {
        "blue": "#AEC0E8", "purple": "#C7B4EC", "mint": "#A8D8C0",
        "peach": "#F0C9A0", "slate": "#CBD5E1",
    }
    TINT_TEXT = {
        "blue": "#2F4FA8", "purple": "#6D3FBF", "mint": "#15795A",
        "peach": "#A85F12", "slate": "#475569",
    }

    ACCENT = "#7C4DE0"
    ACCENT_SOFT = "#EDE4FC"

    PASS = "#16A34A"
    PASS_SOFT = "#DCFCE7"
    FAIL = "#DC2626"
    FAIL_SOFT = "#FEE2E2"
    WARN = "#D97706"
    WARN_SOFT = "#FEF3C7"

    MONO_BG = "#F8FAFC"
    MONO_FG = "#334155"

# Corner radius. corespeed.io uses 0.5rem and 0.75rem and nothing larger;
# a pill-shaped container reads as a button, which a figure region is not.
RADIUS_PANEL = 10 if THEME == "geist" else 12
RADIUS_CARD = 8 if THEME == "geist" else 7
