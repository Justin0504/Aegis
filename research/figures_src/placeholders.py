"""Placeholder figures for the slots Codex will fill (see CODEX-FIGURE-BRIEF.md).

    python -m figures_src.placeholders    # → paper-arxiv/images/{provenance_mechanism,rollout_construction,audit_chain}.pdf

Each placeholder is drawn at the exact design canvas the brief specifies,
so the paper compiles at the final layout and Codex sees the box it must
fill. Replace the file with the real figure; nothing else changes.
"""
from __future__ import annotations

import sys
from pathlib import Path as FsPath

sys.path.insert(0, str(FsPath(__file__).resolve().parent.parent))
from figkit import palette as P                                 # noqa: E402
from figkit.scene import Box, Scene, Text, export               # noqa: E402

OUT = FsPath(__file__).resolve().parent.parent / "paper-arxiv" / "images"

SLOTS = {
    # stem: (W, H, title, brief section, printed width)
    "provenance_mechanism": (1000, 560, "Figure: instruction provenance — which turn authorised the call", "§F2", "\\textwidth"),
    "rollout_construction": (1000, 420, "Figure: instantiation by rollout — how the corpus is built", "§F3", "\\textwidth"),
    "audit_chain":          (500, 300, "Figure: signed, chained traces — and what a tamper does", "§F5", "\\columnwidth"),
}

for stem, (W, H, title, sec, width) in SLOTS.items():
    sc = Scene(W, H, bg=P.WHITE)
    sc.add(Box(6, 6, W - 12, H - 12, fill=P.PAPER, stroke=P.STROKE, radius=P.RADIUS_PANEL))
    sc.add(Text(W / 2, H / 2 - 14, "PLACEHOLDER — to be drawn by Codex", size=max(14, W / 55),
                weight="bold", anchor="middle", color=P.INK_SOFT))
    sc.add(Text(W / 2, H / 2 + 12, title, size=max(12, W / 70), anchor="middle", color=P.INK_SOFT))
    sc.add(Text(W / 2, H / 2 + 36, f"canvas {W}×{H} units · printed at {width} · spec in CODEX-FIGURE-BRIEF.md {sec}",
                size=max(12, W / 80), anchor="middle", color=P.INK_FAINT, mono=True))
    made = export(sc, OUT / stem, png=True, pptx=False)
    print("  ", made["pdf"])
