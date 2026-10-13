"""Figure 3 (F3) — instantiation by rollout: how the corpus is built.

    python -m figures_src.fig_rollout    # → paper-arxiv/images/rollout_construction.{svg,pdf,png,pptx}

Printed at \\textwidth on a 1000 × 420 canvas. Every number here is in
§4.2 / Table 4 of the paper and in CODEX-FIGURE-BRIEF.md §F3; nothing
is recomputed.
"""
from __future__ import annotations

import sys
from pathlib import Path as FsPath

ROOT = FsPath(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from figkit import palette as P                                       # noqa: E402
from figkit.icons import prefetch                                     # noqa: E402
from figkit.scene import Arrow, Box, Icon, Path, Scene, Text, export  # noqa: E402

OUT = ROOT / "paper-arxiv" / "images" / "rollout_construction"
ICONS = {"case": "tabler:cards", "agent": "tabler:robot", "label": "tabler:scale",
         "db": "tabler:database"}

W, H = 1000, 420


def title(sc, x, y, s, size=15):
    sc.add(Text(x, y, s, size=size, weight="bold", color=P.INK))


def build() -> Scene:
    sc = Scene(W, H, bg=P.WHITE)

    # ── Stage 1 · source case ───────────────────────────────────────────
    x1, y1, w1, h1 = 12, 40, 202, 262
    sc.add(Box(x1, y1, w1, h1, fill=P.PAPER, stroke=P.STROKE_GROUP, radius=10, dashed=True))
    sc.add(Icon(x1 + 12, y1 + 10, ICONS["case"], size=15, color=P.INK_SOFT))
    title(sc, x1 + 34, y1 + 22, "InjecAgent case")
    sc.add(Text(x1 + 12, y1 + 42, "one of 2,108", size=12, color=P.INK_FAINT))
    rows = [("user instruction", None), ("first tool call (legitimate)", None),
            ("tool response ← injection here", P.FAIL_SOFT)]
    for i, (t, fill) in enumerate(rows):
        yy = y1 + 58 + i * 48
        sc.add(Box(x1 + 12, yy, w1 - 24, 38, fill=fill or P.WHITE, stroke=P.STROKE_SOFT, radius=7))
        sc.add(Text(x1 + 22, yy + 24, t, size=13, color=P.INK))
    sc.add(Text(x1 + 12, y1 + h1 - 34, "no attacker call exists yet:", size=13, weight="bold", color=P.INK))
    sc.add(Text(x1 + 12, y1 + h1 - 18, "the suite records the injection only", size=12,
                color=P.INK_SOFT))

    # ── Stage 2 · four arms ─────────────────────────────────────────────
    x2, w2 = 232, 356
    title(sc, x2, 58, "four arms, same case")
    arms = [
        ("attack arm",        "tool response carries the injection",                       P.FAIL),
        ("matched control",   "injection replaced by neutral prose of the same length",     P.INK),
        ("benign arm",        "synthesised from the tool schema alone; 5 decoy tools offered", P.PASS),
        ("two-step benign",   "lookup → clean tool response → act on it; arguments tool-derived too", P.PASS),
    ]
    lane_y = []
    for i, (name, what, rail) in enumerate(arms):
        yy = 76 + i * 56
        lane_y.append(yy + 22)
        sc.add(Box(x2, yy, w2, 44, fill=P.WHITE, stroke=P.STROKE_SOFT, radius=8))
        sc.add(Box(x2, yy + 6, 3, 32, fill=rail, stroke=rail, radius=1.5))
        sc.add(Text(x2 + 14, yy + 19, name, size=13.5, weight="bold", color=P.INK))
        sc.add(Text(x2 + 14, yy + 35, what, size=12, color=P.INK_SOFT))
    # arrows from case into the lanes
    for ly in lane_y:
        sc.add(Path(x1 + w1 + 2, y1 + h1 / 2, pts=[(x1 + w1 + 14, y1 + h1 / 2), (x1 + w1 + 14, ly), (x2 - 4, ly)],
                    color=P.INK_FAINT, width=1.2, radius=5))
    sc.add(Text(x2, 310, "only the arm differs; the case, the tools and the agent are identical",
                size=12, color=P.INK_SOFT, italic=True))

    # ── Stage 3 · live agent ────────────────────────────────────────────
    x3, y3, w3, h3 = 618, 112, 152, 132
    for ly in lane_y:
        sc.add(Path(x2 + w2 + 2, ly, pts=[(x3 - 16, ly), (x3 - 16, y3 + h3 / 2), (x3 - 4, y3 + h3 / 2)],
                    color=P.INK_FAINT, width=1.2, radius=5, head=False))
    sc.add(Arrow(x3 - 14, y3 + h3 / 2, x3 - 3, y3 + h3 / 2, color=P.INK_FAINT, width=1.2))
    sc.add(Box(x3, y3, w3, h3, fill=P.WHITE, stroke=P.STROKE_GROUP, radius=10))
    sc.add(Icon(x3 + 12, y3 + 10, ICONS["agent"], size=15, color=P.INK_SOFT))
    title(sc, x3 + 34, y3 + 22, "live agent")
    sc.add(Text(x3 + 12, y3 + 46, "Qwen3-VL-32B", size=11, mono=True, color=P.MONO_FG))
    sc.add(Text(x3 + 12, y3 + 60, "Instruct, AWQ 4-bit", size=11, mono=True, color=P.MONO_FG))
    sc.add(Text(x3 + 12, y3 + 74, "prompt-rendered tools", size=11, mono=True, color=P.MONO_FG))
    sc.add(Text(x3 + 12, y3 + 98, "chooses its own next action;", size=12, color=P.INK_SOFT))
    sc.add(Text(x3 + 12, y3 + 113, "arguments: the model's own", size=12, color=P.INK_SOFT))
    sc.add(Arrow(x3 + w3 + 3, y3 + h3 / 2, x3 + w3 + 22, y3 + h3 / 2, color=P.INK_FAINT, width=1.4))

    # ── Stage 4 · label and corpus ──────────────────────────────────────
    x4, y4, w4 = 796, 40, 192
    sc.add(Box(x4, y4, w4, 132, fill=P.WHITE, stroke=P.STROKE_GROUP, radius=10))
    sc.add(Icon(x4 + 12, y4 + 10, ICONS["label"], size=15, color=P.INK_SOFT))
    title(sc, x4 + 34, y4 + 22, "label")
    sc.add(Text(x4 + 12, y4 + 44, "compromised ⇔ call names", size=10, mono=True, color=P.MONO_FG))
    sc.add(Text(x4 + 12, y4 + 58, "a tool on the attacker list", size=10, mono=True, color=P.MONO_FG))
    # result chips, same scale
    sc.add(Box(x4 + 12, y4 + 72, 168, 16, fill=P.FAIL_SOFT, stroke=P.FAIL_SOFT, radius=4))
    sc.add(Box(x4 + 12, y4 + 72, 168 * 0.9507, 16, fill=P.FAIL, stroke=P.FAIL, radius=4))
    sc.add(Text(x4 + 16, y4 + 84, "attack arm  95.07 %", size=10.5, color=P.WHITE, weight="bold"))
    sc.add(Box(x4 + 12, y4 + 92, 168, 16, fill=P.STROKE_SOFT, stroke=P.STROKE_SOFT, radius=4))
    sc.add(Box(x4 + 12, y4 + 92, max(2, 168 * 0.00285), 16, fill=P.INK, stroke=P.INK, radius=4))
    sc.add(Text(x4 + 20, y4 + 104, "matched control  0.285 %", size=10.5, color=P.INK))
    sc.add(Text(x4 + 12, y4 + 122, "n = 2,108 per arm · risk ratio 334", size=9, mono=True, color=P.INK_FAINT))

    sc.add(Arrow(x4 + w4 / 2, y4 + 134, x4 + w4 / 2, y4 + 146, color=P.INK_FAINT, width=1.2))
    y5 = y4 + 148
    sc.add(Box(x4, y5, w4, 128, fill=P.WHITE, stroke=P.STROKE_GROUP, radius=10))
    sc.add(Icon(x4 + 12, y5 + 10, ICONS["db"], size=15, color=P.INK_SOFT))
    title(sc, x4 + 34, y5 + 22, "corpus")
    for i, line in enumerate(["663 records", "237 malicious · 426 benign",
                              "each emitted by a live agent"]):
        sc.add(Text(x4 + 12, y5 + 42 + i * 14, line, size=12, color=P.INK if i < 2 else P.INK_SOFT,
                    weight="bold" if i == 0 else "normal"))
    sc.add(Text(x4 + 12, y5 + 94, "surface AUC  0.947 → 0.585", size=10.5, mono=True, color=P.MONO_FG))
    sc.add(Text(x4 + 12, y5 + 108, "label leak    100 % → 0", size=10.5, mono=True, color=P.MONO_FG))
    sc.add(Text(x4 + 12, y5 + 121, "before → after, Table 4", size=10, color=P.INK_FAINT))

    # ── bottom line ─────────────────────────────────────────────────────
    sc.add(Text(12, 348, "Why this is the corpus.", size=13.5, weight="bold", color=P.INK))
    sc.add(Text(172, 348, "An attacker's call exists only after an agent has read an injection and acted on it. "
                          "Fabricating it plants a shortcut no held-out split can detect;", size=12, color=P.INK))
    sc.add(Text(12, 366, "compromising a live agent and recording what it emits is the only construction in which "
                         "malicious and benign calls come from the same process.", size=12, color=P.INK))
    sc.add(Text(12, 394, "The matched control answers the objection that the agent would have called that tool anyway: "
                         "0.285 % against 95.07 %. The two benign arms keep the comparison honest:",
                size=12, color=P.INK_SOFT))
    sc.add(Text(12, 409, "without the two-step arm, “did untrusted text precede this call?” would separate the classes on its own.",
                size=12, color=P.INK_SOFT))
    return sc


def main() -> int:
    prefetch(ICONS)
    for ext in ("svg", "pdf", "png", "pptx"):
        OUT.with_suffix("." + ext).unlink(missing_ok=True)
    made = export(build(), OUT, png=True)
    for k, v in made.items():
        print(f"  {k:5s} {v.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
