"""Figure 5 (F5) — signed, chained traces, and what a tamper does.

    python -m figures_src.fig_audit      # → paper-arxiv/images/audit_chain.{svg,pdf,png,pptx}

Printed at \\columnwidth (≈240 pt) on a 500 × 300 canvas, so one unit is
0.48 pt: the type floor is 12 units (≈6 pt), and everything that cannot
be said at that size is cut. Top row: the chain as recorded. Bottom row:
the same chain after an attendee edits one field of t; verification
fails from t onward and stays green before it (§2.5).
"""
from __future__ import annotations

import sys
from pathlib import Path as FsPath

ROOT = FsPath(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from figkit import palette as P                                   # noqa: E402
from figkit.icons import prefetch                                 # noqa: E402
from figkit.scene import Arrow, Box, Icon, Scene, Text, export    # noqa: E402

OUT = ROOT / "paper-arxiv" / "images" / "audit_chain"
ICONS = {"ok": "tabler:circle-check", "fail": "tabler:circle-x", "edit": "tabler:pencil"}

W, H = 500, 300
BW, BH, GAP = 104, 60, 20
X0 = 12


def block(sc: Scene, x: float, y: float, name: str, *, edited=False, broken=False):
    stroke = P.FAIL if (edited or broken) else P.STROKE_GROUP
    sc.add(Box(x, y, BW, BH, fill=P.WHITE, stroke=stroke, radius=6,
               width=1.8 if (edited or broken) else 1.0))
    sc.add(Text(x + 9, y + 20, name, size=15, weight="bold", color=P.INK))
    sc.add(Text(x + 9, y + 37, "sig  Ed25519", size=11.5, mono=True, color=P.MONO_FG))
    sc.add(Text(x + 9, y + 52, "H=SHA256(d‖H′)", size=11.5, mono=True,
                color=P.FAIL if edited else P.MONO_FG))
    if edited:
        sc.add(Icon(x + BW - 22, y + 7, ICONS["edit"], size=14, color=P.FAIL))


def chain(sc: Scene, y: float, names, *, edited_at=None):
    for i, n in enumerate(names):
        x = X0 + i * (BW + GAP)
        ed = edited_at is not None and i == edited_at
        br = edited_at is not None and i > edited_at
        block(sc, x, y, n, edited=ed, broken=br)
        if i < len(names) - 1:
            col = P.FAIL if (edited_at is not None and i >= edited_at) else P.INK_FAINT
            sc.add(Arrow(x + BW + 2, y + BH / 2, x + BW + GAP - 2, y + BH / 2, color=col, width=1.6))


def marks(sc: Scene, y: float, fail_from=None):
    for i in range(4):
        x = X0 + i * (BW + GAP)
        ok = fail_from is None or i < fail_from
        sc.add(Icon(x + 9, y, ICONS["ok" if ok else "fail"], size=13, color=P.PASS if ok else P.FAIL))
        sc.add(Text(x + 26, y + 11, "ok" if ok else "FAIL", size=12, weight="normal" if ok else "bold",
                    color=P.PASS if ok else P.FAIL))


def build() -> Scene:
    sc = Scene(W, H, bg=P.WHITE)
    names = ["t−2", "t−1", "t", "t+1"]

    sc.add(Text(X0, 20, "as recorded", size=14, weight="bold", color=P.INK))
    sc.add(Text(X0 + 104, 20, "each trace commits to the previous hash, H′", size=12, color=P.INK_SOFT))
    sc.add(Text(X0, 38, "chain heads → Merkle root → transparency log → witnesses", size=11.5,
                mono=True, color=P.INK_FAINT))
    chain(sc, 48, names)
    marks(sc, 116)

    sc.add(Box(X0, 146, 4 * BW + 3 * GAP, 1, fill=P.STROKE, stroke=P.STROKE, radius=0))

    sc.add(Text(X0, 170, "after one field of t is edited", size=14, weight="bold", color=P.INK))
    sc.add(Text(X0 + 232, 170, "in the exported log, by an attendee", size=12, color=P.INK_SOFT))
    chain(sc, 182, names, edited_at=2)
    marks(sc, 250, fail_from=2)
    sc.add(Text(X0, 288, "verify: FAIL from t — t’s content hash no longer matches, so t+1’s link breaks too",
                size=12, color=P.FAIL))
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
