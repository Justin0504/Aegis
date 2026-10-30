"""Figure (L2) — the behavioural-anomaly layer as a pipeline.

    python -m figures_src.fig_anomaly   # → paper-arxiv/images/anomaly.{svg,pdf,png,pptx}

Printed at \\columnwidth (≈240 pt) on a 500 × 320 canvas, so one unit is
about 0.48 pt and the type floor is 12 units (≈6 pt). The story, left to
right: a 16-dimensional behaviour vector scored against the agent's own
baseline by three estimators into one conformal p-value; a cold-start cap
that forbids a young profile from blocking; and two feedback paths ---
ADWIN drift resets the normalisation, an operator's answer on a held call
flows back into the reservoir (§2.3, §2.x Human-in-the-Loop). Every number
here appears in the paper's prose.
"""
from __future__ import annotations

import sys
from pathlib import Path as FsPath

ROOT = FsPath(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from figkit import palette as P                                   # noqa: E402
from figkit.icons import prefetch                                 # noqa: E402
from figkit.scene import Arrow, Box, Icon, Path, Scene, Text, export  # noqa: E402

OUT = ROOT / "paper-arxiv" / "images" / "anomaly"
ICONS = {
    "vec": "tabler:chart-line",
    "forest": "tabler:binary-tree",
    "dist": "tabler:scale",
    "drift": "tabler:refresh",
    "fb": "tabler:user-check",
    "up": "tabler:arrows-split-2",
}

W, H = 500, 330
PH = 206                 # shared panel height
PY = 20                  # shared panel top
MID = PY + PH / 2        # vertical centre, for the A->B->C arrows


def label(sc, x, y, t, *, size=12, color=P.INK_SOFT, mono=False, weight="normal", anchor="start"):
    sc.add(Text(x, y, t, size=size, color=color, mono=mono, weight=weight, anchor=anchor))


def build() -> Scene:
    sc = Scene(W, H, bg=P.WHITE)

    # ---- (A) the 16-d behaviour vector, grouped by what it measures ------
    ax, aw = 10, 150
    sc.add(Box(ax, PY, aw, PH, fill=P.WHITE, stroke=P.STROKE_GROUP, radius=8))
    sc.add(Icon(ax + 10, PY + 10, ICONS["vec"], size=14, color=P.ACCENT))
    label(sc, ax + 30, PY + 21, "16-d behaviour", size=12.5, color=P.INK, weight="bold")
    label(sc, ax + 30, PY + 35, "vector", size=12.5, color=P.INK, weight="bold")
    label(sc, ax + 10, PY + 52, "scored vs. the agent's", size=11, color=P.INK_FAINT)
    label(sc, ax + 10, PY + 64, "own baseline", size=11, color=P.INK_FAINT)
    fams = [
        ("tool novelty", "freq · recency"),
        ("argument drift", "Jaccard · len-z"),
        ("timing", "hour · burst"),
        ("sequence", "PPM-C · bigram"),
        ("cost / risk", "z · ordinal"),
    ]
    fy = PY + 72
    for i, (h, d) in enumerate(fams):
        yy = fy + i * 25
        sc.add(Box(ax + 10, yy, aw - 20, 22, fill=P.MONO_BG, stroke=P.STROKE_SOFT, radius=4))
        label(sc, ax + 17, yy + 10, h, size=11, color=P.INK, weight="bold")
        label(sc, ax + 17, yy + 19, d, size=10.5, color=P.MONO_FG, mono=True)

    # ---- (B) three estimators into one calibrated score ------------------
    bx, bw = 182, 150
    sc.add(Box(bx, PY, bw, PH, fill=P.WHITE, stroke=P.STROKE_GROUP, radius=8))
    label(sc, bx + 10, PY + 21, "ensemble", size=12.5, color=P.INK, weight="bold")
    ests = [
        (ICONS["forest"], "Isolation Forest"),
        (ICONS["forest"], "half-space trees"),
        (ICONS["dist"], "Mahalanobis"),
    ]
    ey = PY + 34
    for i, (ic, t) in enumerate(ests):
        yy = ey + i * 30
        sc.add(Box(bx + 10, yy, bw - 20, 24, fill=P.WHITE, stroke=P.STROKE_SOFT, radius=5))
        sc.add(Icon(bx + 17, yy + 5, ic, size=13, color=P.INK_SOFT))
        label(sc, bx + 37, yy + 16, t, size=11, color=P.INK)
    sy = ey + 3 * 30 + 6
    sc.add(Box(bx + 10, sy, bw - 20, 26, fill=P.ACCENT_SOFT, stroke=P.ACCENT, radius=6))
    label(sc, bx + 18, sy + 17, "anomaly score", size=11.5, color=P.INK, weight="bold")
    label(sc, bx + 10, sy + 44, "split-conformal p", size=11, color=P.INK_SOFT)
    label(sc, bx + 10, sy + 57, "reported, not decided", size=10.5, color=P.INK_FAINT)

    # ---- (C) cold-start cap on the decision ------------------------------
    cx, cw = 354, 136
    sc.add(Box(cx, PY, cw, PH, fill=P.WHITE, stroke=P.STROKE_GROUP, radius=8))
    label(sc, cx + 10, PY + 21, "decision cap", size=12.5, color=P.INK, weight="bold")
    label(sc, cx + 10, PY + 34, "by cold-start phase", size=10.5, color=P.INK_FAINT)
    phases = [
        ("learning", "observe only", P.INK_FAINT),
        ("graduated", "≤ flag", P.WARN),
        ("active", "may block", P.FAIL),
    ]
    py = PY + 46
    for i, (name, rule, col) in enumerate(phases):
        yy = py + i * 33
        sc.add(Box(cx + 10, yy, cw - 20, 28, fill=P.WHITE, stroke=P.STROKE_SOFT, radius=5))
        label(sc, cx + 18, yy + 12, name, size=11, color=P.INK, weight="bold")
        label(sc, cx + 18, yy + 24, rule, size=10.5, color=col)
    iy = py + 3 * 33 + 4
    sc.add(Icon(cx + 10, iy - 2, ICONS["up"], size=13, color=P.PASS))
    label(sc, cx + 28, iy + 9, "tightens only;", size=10.5, color=P.PASS)
    label(sc, cx + 28, iy + 21, "never relaxes", size=10.5, color=P.PASS)

    # arrows A -> B -> C
    sc.add(Arrow(ax + aw + 2, MID, bx - 2, MID, color=P.INK_FAINT, width=1.6))
    sc.add(Arrow(bx + bw + 2, MID, cx - 2, MID, color=P.INK_FAINT, width=1.6))

    # ---- feedback strip --------------------------------------------------
    gy = PY + PH + 12
    sc.add(Box(10, gy, aw, 80, fill=P.MONO_BG, stroke=P.STROKE_SOFT, radius=8))
    sc.add(Icon(20, gy + 10, ICONS["drift"], size=14, color=P.WARN))
    label(sc, 40, gy + 21, "ADWIN drift", size=11.5, color=P.INK, weight="bold")
    label(sc, 20, gy + 41, "resets feature", size=11, color=P.INK_SOFT)
    label(sc, 20, gy + 55, "normalisation;", size=11, color=P.INK_SOFT)
    label(sc, 20, gy + 69, "keeps the reservoir", size=11, color=P.INK_SOFT)

    sc.add(Box(182, gy, 308, 80, fill=P.MONO_BG, stroke=P.STROKE_SOFT, radius=8))
    sc.add(Icon(192, gy + 10, ICONS["fb"], size=14, color=P.ACCENT))
    label(sc, 212, gy + 21, "operator feedback — active anomaly discovery", size=11.5, color=P.INK, weight="bold")
    label(sc, 192, gy + 41, "an approve / reject on a held call scored > 0.3 flows", size=11, color=P.INK_SOFT)
    label(sc, 192, gy + 55, "back into the reservoir and the score tracker, so the", size=11, color=P.INK_SOFT)
    label(sc, 192, gy + 69, "layer moves toward the operator's notion of normal.", size=11, color=P.INK_SOFT)

    # feedback arrow from the strip up into the ensemble panel
    sc.add(Path(300, gy, pts=[(300, gy - 7), (257, gy - 7), (257, PY + PH + 2)],
                color=P.ACCENT, width=1.4, dashed=True))

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
