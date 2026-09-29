"""Figure 1 — where Aegis sits, and what each layer can actually see.

    python -m figures_src.fig_architecture

The previous version of this figure was a feature inventory: every box
carried equal weight, dotted decision lines crossed the scan panel, and
the Cockpit column listed eight tab names. A reader could not recover
from it the one thing the paper turns on, which is that the layers
differ in *what they are allowed to look at*, not merely in cost.

So the cascade row is ordered by observation scope and each layer states
its input explicitly. The two results the paper actually establishes are
printed on the layers they belong to, rather than left to the caption:
patterns see only the call string and catch 0.4% of real attacks; the
provenance block sees the channel split and reaches 0.991.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from figkit import palette as P                                  # noqa: E402
from figkit.icons import prefetch                                # noqa: E402
from figkit.scene import Arrow, Box, Icon, Scene, Text, export   # noqa: E402

OUT = ROOT / "paper-arxiv" / "images" / "architecture"

ICONS = {
    "agent":  "tabler:robot",
    "tool":   "tabler:tool",
    "shield": "tabler:shield-half",
    "regex":  "tabler:regex",
    "tree":   "tabler:binary-tree",
    "brain":  "tabler:bulb",
    "route":  "tabler:route",
    "user":   "tabler:user-check",
    "lock":   "tabler:lock-check",
    "db":     "tabler:database",
}


def build() -> Scene:
    W, H = 1000, 350
    sc = Scene(W, H, bg=P.WHITE)

    # ---- principal ------------------------------------------------------
    sc.panel(12, 14, 150, 214, "Agent", tint="slate")
    sc.card(24, 42, 126, 30, "LLM", size=9, icon=ICONS["agent"])
    sc.add(Text(30, 88, "untrusted principal", size=7.6, color=P.INK_SOFT,
                italic=True))
    sc.card(24, 96, 126, 30, "Tools", size=9, icon=ICONS["tool"])
    sc.add(Text(30, 142, "DB · shell · files · HTTP", size=7.6,
                color=P.INK_SOFT))
    sc.add(Box(24, 152, 126, 62, fill=P.MONO_BG, stroke=P.STROKE_SOFT,
               radius=5))
    sc.add(Text(34, 168, "tool_use {", size=7.4, mono=True,
                color=P.MONO_FG))
    sc.add(Text(34, 182, '  name: "execute_sql",', size=7.4, mono=True,
                color=P.MONO_FG))
    sc.add(Text(34, 196, "  arguments: {…}", size=7.4, mono=True,
                color=P.MONO_FG))
    sc.add(Text(24, 246, "14 frameworks · Python / JS / Go", size=7.6,
                color=P.INK_SOFT))
    sc.code(24, 254, 126, 22, "agentguard.auto()")

    sc.add(Arrow(164, 120, 190, 120))
    sc.add(Text(177, 112, "tool_use", size=7.2, color=P.INK_SOFT,
                anchor="middle"))

    # ---- the gateway ----------------------------------------------------
    sc.add(Box(194, 14, 596, 262, fill=P.PAPER, stroke=P.STROKE_GROUP,
               radius=12, dashed=True))
    sc.add(Text(208, 34, "Aegis Gateway", size=11.5, weight="bold"))
    sc.add(Text(208, 49, "pre-execution mediation — the call has not run yet",
                size=8, color=P.INK_SOFT, italic=True))

    # Each layer states what it may observe. That is the axis of the paper.
    layers = [
        (206, "blue",   "L1  patterns", ICONS["regex"], "sees: call string",
         "22 patterns, <1 ms", "0.4% of real attacks", P.FAIL),
        (352, "slate",  "L2  classifier", ICONS["tree"], "sees: 15 features",
         "XGBoost / IForest", "surface only", P.INK_SOFT),
        (498, "mint",   "Lp  provenance", ICONS["route"],
         "sees: channel split", "6 features, <1 ms", "AUC 0.991", P.PASS),
        (644, "purple", "L3  judge", ICONS["brain"], "sees: full context",
         "frontier model", "0.851 bal.acc, 2.3 s", P.WARN),
    ]
    for x, tint, name, icon, scope, impl, result, rescol in layers:
        sc.panel(x, 62, 132, 126, None, tint=tint)
        sc.add(Icon(x + 10, 70, icon, size=15, color=P.TINT_TEXT[tint]))
        sc.add(Text(x + 32, 82, name, size=9.5, weight="bold",
                    color=P.TINT_TEXT[tint]))
        sc.add(Box(x + 8, 94, 116, 18, fill=P.WHITE, stroke=P.STROKE_SOFT,
                   radius=4))
        sc.add(Text(x + 14, 107, scope, size=7.4, mono=True, color=P.INK))
        sc.add(Text(x + 10, 128, impl, size=7.8, color=P.INK_SOFT))
        sc.add(Box(x + 8, 138, 116, 20, fill=P.WHITE, stroke=P.STROKE_SOFT,
                   radius=4))
        sc.add(Text(x + 66, 152, result, size=8, weight="bold",
                    color=rescol, anchor="middle"))

    sc.add(Text(206, 200, "measured on real agent traffic "
                "(the instantiated corpus)", size=7.4,
                color=P.INK_FAINT, italic=True))

    for x in (338, 484, 630):
        sc.add(Arrow(x, 122, x + 14, 122))

    # decisions
    sc.add(Text(208, 214, "decision", size=8, weight="bold", color=P.INK))
    sc.chip(206, 222, 74, 22, "allow", fill=P.PASS_SOFT, fg=P.PASS, size=8.5)
    sc.chip(288, 222, 74, 22, "block", fill=P.FAIL_SOFT, fg=P.FAIL, size=8.5)
    sc.chip(370, 222, 90, 22, "pending", fill=P.WARN_SOFT, fg=P.WARN, size=8.5)
    sc.add(Arrow(462, 233, 486, 233))
    sc.card(492, 218, 160, 30, "human review, 1 click", size=8.5,
            icon=ICONS["user"])
    sc.add(Text(668, 236, "agent suspended", size=7.6, color=P.INK_SOFT,
                italic=True))

    # ---- audit ----------------------------------------------------------
    sc.panel(802, 14, 186, 130, "Tamper-evident audit", tint="peach",
             title_size=10)
    sc.card(812, 44, 166, 26, "Ed25519 signature", size=8.5, icon=ICONS["lock"])
    sc.card(812, 76, 166, 26, "SHA-256 hash chain", size=8.5, icon=ICONS["db"])
    sc.code(812, 108, 166, 24, "H(t) = SHA256(d ‖ H(t-1))", size=6.8)

    sc.panel(802, 152, 186, 124, "Compliance Cockpit", tint="blue",
             title_size=10)
    sc.add(Text(812, 182, "live feed · approvals · anomalies", size=7.8,
                color=P.INK_SOFT))
    sc.add(Text(812, 196, "violations · costs · sessions", size=7.8,
                color=P.INK_SOFT))
    sc.card(812, 206, 166, 26, "PDF / CSV export", size=8.5,
            icon="tabler:file-export")
    sc.add(Text(812, 252, "every decision, signed and chained", size=7.4,
                color=P.INK_FAINT, italic=True))

    sc.add(Arrow(782, 200, 800, 200, dashed=True, color=P.INK_FAINT))
    sc.add(Text(791, 192, "log trace", size=7, color=P.INK_SOFT,
                anchor="middle"))

    # ---- the finding, stated on the figure ------------------------------
    sc.add(Box(12, 292, 976, 48, fill=P.TINT["mint"], stroke=P.TINT_EDGE["mint"],
               radius=9))
    sc.add(Icon(26, 304, ICONS["shield"], size=16, color=P.TINT_TEXT["mint"]))
    sc.add(Text(50, 310, "The layers differ in what they may observe, not "
                         "only in cost — and that is what decides the outcome.",
                size=9.5, weight="bold", color=P.TINT_TEXT["mint"]))
    sc.add(Text(50, 326, "A successful indirect injection emits a syntactically "
                         "ordinary call, so L1 and L2 have nothing to inspect. "
                         "Lp recovers the signal at L1 cost by asking which "
                         "turn authorised the call.",
                size=8.6, color="#0F5B44"))
    return sc


def main() -> int:
    prefetch(ICONS)
    made = export(build(), OUT, png=True)
    for k, v in made.items():
        print(f"  {k:5s} {v.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
