"""Figure 1 — the control point, and what comes back from it.

    python -m figures_src.fig_architecture

WHAT THE EARLIER VERSIONS GOT WRONG

The original was a feature inventory: emoji icons, dotted lines crossing
the scan panel, eight Cockpit tab names, every box at equal weight.

The version after that fixed the weighting but inherited a research
paper's priorities --- each cascade layer carried its AUC, and a band
across the bottom stated the paper's finding. Once the paper was
rebalanced as a demonstration, those numbers belonged in the evaluation
table, not in the system figure.

Both shared a worse omission: every arrow pointed left to right. A
mediation layer is defined by what comes *back* from it, and the single
claim the demonstration rests on --- that a block returns in-band, so the
agent explains itself and continues rather than failing --- was nowhere
in the figure at all.

SO THIS ONE IS ORGANISED AS A LOOP

Outbound along the top, the three decisions in the middle, and three
distinct return paths drawn explicitly, because they differ in exactly
the way an attendee needs to see:

    allow    the tool runs, its result returns normally
    block    the tool never runs; a refusal returns in the same slot a
             tool result would have, which is why the agent recovers
    pending  the turn suspends until a person decides

Circled numbers mark where a human touches the system, since that is
what a demo audience is being invited to do.
"""

from __future__ import annotations

import sys
from pathlib import Path as FsPath

ROOT = FsPath(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from figkit import palette as P                                       # noqa: E402
from figkit.icons import prefetch                                     # noqa: E402
from figkit.scene import (                                            # noqa: E402
    Arrow, Box, Icon, Image, Path, Scene, Text, export,
)

OUT = ROOT / "paper-arxiv" / "images" / "architecture"

ICONS = {
    "agent":  "tabler:robot",
    "regex":  "tabler:regex",
    "tree":   "tabler:binary-tree",
    "route":  "tabler:route",
    "brain":  "tabler:bulb",
    "user":   "tabler:user-check",
    "lock":   "tabler:lock-check",
    "chart":  "tabler:layout-dashboard",
    "plug":   "tabler:plug-connected",
}


def numbered(sc: Scene, x: float, y: float, n: str, tint: str = "purple"):
    """A circled step number, for the points where a person acts."""
    sc.add(Box(x, y, 15, 15, fill=P.TINT_TEXT[tint], stroke=P.TINT_TEXT[tint],
               radius=7.5))
    sc.add(Text(x + 7.5, y + 11, n, size=15, weight="bold", color=P.WHITE,
                anchor="middle"))


def build() -> Scene:
    # Design width matches the printed width closely enough that a 12-unit
    # label lands at ~6pt in the PDF. Everything below is sized against that
    # floor, and text that could not be said at that size was cut rather
    # than shrunk.
    W, H = 1000, 470
    sc = Scene(W, H, bg=P.WHITE)

    AG_X, AG_W = 12, 148
    GW_X, GW_W = 184, 620
    RT_X, RT_W = 816, 172

    # ---- agent ----------------------------------------------------------
    sc.panel(AG_X, 40, AG_W, 218, "Agent", tint="slate", title_size=15)
    sc.card(AG_X + 12, 72, AG_W - 24, 34, "LLM", size=13, icon=ICONS["agent"])
    sc.add(Text(AG_X + 14, 126, "untrusted principal", size=11.5,
                color=P.INK_SOFT, italic=True))

    sc.add(Box(AG_X + 12, 138, AG_W - 24, 56, fill=P.WHITE,
               stroke=P.TINT_EDGE["mint"], radius=6))
    sc.add(Icon(AG_X + 20, 148, ICONS["plug"], size=14,
                color=P.TINT_TEXT["mint"]))
    sc.add(Text(AG_X + 42, 160, "two lines", size=12.5, weight="bold",
                color=P.TINT_TEXT["mint"]))
    sc.add(Text(AG_X + 18, 184, "agentguard.auto()", size=10.8, mono=True,
                color=P.MONO_FG))

    sc.add(Text(AG_X + 14, 216, "14 frameworks", size=12, color=P.INK_SOFT))
    sc.add(Text(AG_X + 14, 234, "Python \u00b7 JS \u00b7 Go", size=11.5,
                color=P.INK_FAINT))
    numbered(sc, AG_X + AG_W - 26, 46, "1")

    sc.add(Arrow(AG_X + AG_W + 4, 100, GW_X - 6, 100))

    # ---- gateway --------------------------------------------------------
    sc.add(Box(GW_X, 40, GW_W, 218, fill=P.PAPER, stroke=P.STROKE_GROUP,
               radius=12, dashed=True))
    sc.add(Text(GW_X + 16, 66, "Aegis Gateway", size=17, weight="bold"))
    sc.add(Text(GW_X + 16, 84, "the call has not run yet", size=12,
                color=P.INK_SOFT, italic=True))

    lw, lg = 140, 12
    lx0 = GW_X + 16
    layers = [
        ("L1  rules", "blue", ICONS["regex"], "call string", "<1 ms", False),
        ("L2  classifier", "slate", ICONS["tree"], "15 features", "<10 ms", False),
        ("L3  judge", "purple", ICONS["brain"], "full context", "1\u20132 s", False),
        ("Lp  provenance", "mint", ICONS["route"], "channel split",
         "<1 ms \u00b7 optional", True),
    ]
    for i, (name, tint, icon, sees, cost, dashed) in enumerate(layers):
        x = lx0 + i * (lw + lg)
        sc.add(Box(x, 96, lw, 96, fill=P.TINT[tint], stroke=P.TINT_EDGE[tint],
                   radius=12, dashed=dashed))
        sc.add(Icon(x + 10, 104, icon, size=15, color=P.TINT_TEXT[tint]))
        sc.add(Text(x + 32, 118, name, size=13, weight="bold",
                    color=P.TINT_TEXT[tint]))
        sc.add(Box(x + 9, 132, lw - 18, 24, fill=P.WHITE,
                   stroke=P.STROKE_SOFT, radius=4))
        sc.add(Text(x + lw / 2, 148, sees, size=11.5, mono=True, color=P.INK,
                    anchor="middle"))
        sc.add(Text(x + 12, 180, cost, size=11.5, color=P.INK_SOFT))
        if i < 3:
            sc.add(Arrow(x + lw + 1, 144, x + lw + lg - 1, 144))


    # ---- decisions ------------------------------------------------------
    sc.add(Text(GW_X + 16, 218, "decision", size=13, weight="bold",
                color=P.INK))
    for x, w, label, fill, fg in [
        (GW_X + 92, 92, "allow", P.PASS_SOFT, P.PASS),
        (GW_X + 196, 92, "block", P.FAIL_SOFT, P.FAIL),
        (GW_X + 300, 104, "pending", P.WARN_SOFT, P.WARN),
    ]:
        sc.add(Box(x, 204, w, 32, fill=fill, stroke=fill, radius=16))
        sc.add(Text(x + w / 2, 225, label, size=13, weight="bold", color=fg,
                    anchor="middle"))

    sc.add(Arrow(GW_X + 410, 220, GW_X + 430, 220))
    sc.card(GW_X + 436, 204, 168, 32, "human approval", size=12.5,
            icon=ICONS["user"])
    numbered(sc, GW_X + 588, 208, "2")

    # ---- return paths ----------------------------------------------------
    for sx, ly, ex, col, wd, dash in [
        (GW_X + 138, 300, AG_X + 74, P.PASS, 1.8, False),
        (GW_X + 242, 322, AG_X + 98, P.FAIL, 2.2, False),
        (GW_X + 352, 344, AG_X + 50, P.WARN, 1.8, True),
    ]:
        sc.add(Path(sx, 238, pts=[(sx, ly), (ex, ly), (ex, 262)],
                    color=col, width=wd, dashed=dash))

    LX, LY = 604, 276
    sc.add(Box(LX, LY, 384, 100, fill=P.WHITE, stroke=P.STROKE_SOFT, radius=8))
    for i, (col, tag, txt) in enumerate([
        (P.PASS, "allow", "the tool runs; its result returns normally"),
        (P.FAIL, "block", "the tool never runs \u2014 a refusal returns"),
        (P.WARN, "pending", "the turn suspends until a person decides"),
    ]):
        y = LY + 26 + i * 26
        sc.add(Text(LX + 14, y, tag, size=12, weight="bold", color=col))
        sc.add(Text(LX + 86, y, txt, size=12, color=P.INK))
    sc.add(Text(LX + 86, LY + 65, "where a tool result would", size=12,
                color=P.INK))

    sc.add(Text(AG_X, 404, "The refusal arrives in-band \u2014 which is why a "
                "blocked agent explains itself and continues", size=13,
                weight="bold", color=P.TINT_TEXT["mint"]))
    sc.add(Text(AG_X, 422, "the conversation instead of failing.", size=13,
                weight="bold", color=P.TINT_TEXT["mint"]))

    # ---- audit + cockpit -------------------------------------------------
    sc.add(Arrow(GW_X + GW_W + 4, 100, RT_X - 6, 100, dashed=True,
                 color=P.INK_FAINT, width=1.4))
    sc.panel(RT_X, 40, RT_W, 116, "Tamper-evident", tint="peach",
             title_size=13)
    sc.card(RT_X + 10, 70, RT_W - 20, 30, "Ed25519", size=12,
            icon=ICONS["lock"])
    sc.code(RT_X + 10, 108, RT_W - 20, 28, "SHA-256 chain", size=11.5)
    numbered(sc, RT_X + RT_W - 24, 46, "3")

    sc.panel(RT_X, 168, RT_W, 90, "Cockpit", tint="blue", title_size=13)
    sc.card(RT_X + 10, 196, RT_W - 20, 30, "live feed", size=12,
            icon=ICONS["chart"])
    sc.add(Text(RT_X + 12, 244, "approvals \u00b7 export", size=11.5,
                color=P.INK_SOFT))

    # ---- attendee legend -------------------------------------------------
    sc.add(Text(AG_X, 452, "Where an attendee acts:", size=12,
                weight="bold", color=P.INK))
    for x, t in [(196, "1  drives the agent"),
                 (356, "2  approves or blocks a held call"),
                 (600, "3  tampers with the signed log, verification fails")]:
        sc.add(Text(x, 452, t, size=12, color=P.INK_SOFT))
    return sc


def main() -> int:
    prefetch(ICONS)
    made = export(build(), OUT, png=True)
    for k, v in made.items():
        print(f"  {k:5s} {v.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
