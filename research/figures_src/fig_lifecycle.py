"""Figure (F11) — one tool call across the trust boundary, in time.

    python -m figures_src.fig_lifecycle  # → paper-arxiv/images/lifecycle.{svg,pdf,png,pptx}

The static cascade (Fig.~\\ref{fig:cascade}) says what each layer may see;
the deployment figure (Fig.~\\ref{fig:deployment}) says where each part
runs. This one says *when*: a swimlane sequence of a single call, with the
request-side ledger write that happens before the model is even called,
the response-side interception that suspends dispatch, the ordered layers,
the three return paths, and the trace the whole episode leaves. Printed at
\\textwidth (figure*) on a 960 × 330 canvas, so one unit is about 0.52 pt
and the type floor is 12 units (≈6 pt). Every latency and bound printed
here is from the paper's prose (§2).
"""
from __future__ import annotations

import sys
from pathlib import Path as FsPath

ROOT = FsPath(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from figkit import palette as P                                   # noqa: E402
from figkit.icons import prefetch                                 # noqa: E402
from figkit.scene import Arrow, Box, Icon, Path, Scene, Text, export  # noqa: E402

OUT = ROOT / "paper-arxiv" / "images" / "lifecycle"
ICONS = {
    "agent": "tabler:robot",
    "gw": "tabler:shield-half",
    "rev": "tabler:user-check",
    "log": "tabler:database",
    "receipt": "tabler:lock-check",
    "clock": "tabler:clock",
}

W, H = 1000, 324
LX, LW = 8, 148                      # lane label column
TX = LX + LW + 10                    # timeline starts here


def T(sc, x, y, t, *, size=12, color=P.INK_SOFT, mono=False, weight="normal", anchor="start"):
    sc.add(Text(x, y, t, size=size, color=color, mono=mono, weight=weight, anchor=anchor))


def lane(sc, y, h, title, sub, icon):
    sc.add(Box(LX, y, W - 2 * LX, h, fill=P.TINT["slate"], stroke=P.STROKE_SOFT, radius=8))
    sc.add(Box(LX, y, LW, h, fill=P.WHITE, stroke=P.STROKE_SOFT, radius=8))
    sc.add(Icon(LX + 12, y + 11, icon, size=16, color=P.INK_SOFT))
    T(sc, LX + 34, y + 20, title, size=12.5, color=P.INK, weight="bold")
    T(sc, LX + 12, y + 37, sub, size=11, color=P.INK_FAINT)


def step(sc, n, x, y):
    sc.add(Box(x, y, 17, 17, fill=P.INK, stroke=P.INK, radius=8.5))
    sc.add(Text(x + 8.5, y + 12, str(n), size=11, color=P.WHITE, weight="bold", anchor="middle"))


def card(sc, x, y, w, h, lines, *, stroke=P.STROKE_GROUP, fill=P.WHITE):
    sc.add(Box(x, y, w, h, fill=fill, stroke=stroke, radius=6))
    yy = y + 15
    for t, kw in lines:
        sc.add(Text(x + 9, yy, t, **{"size": 11.5, "color": P.INK, **kw}))
        yy += kw.get("dy", 14)


def build() -> Scene:
    sc = Scene(W, H, bg=P.WHITE)

    yA, yG, yR, yL = 28, 118, 210, 270
    hA, hG, hR, hL = 82, 84, 52, 46
    lane(sc, yA, hA, "Agent host", "SDK, two lines", ICONS["agent"])
    lane(sc, yG, hG, "AEGIS gateway", "operator side", ICONS["gw"])
    lane(sc, yR, hR, "Reviewer", "auditor → person", ICONS["rev"])
    lane(sc, yL, hL, "Audit log", "hash chain", ICONS["log"])

    midA = yA + hA / 2

    # time axis hint
    T(sc, W - 62, 18, "time →", size=11.5, color=P.INK_FAINT)

    # 1 — request side: classify context, write the ledger, before the model call
    x1 = TX
    step(sc, 1, x1, yA + 4)
    card(sc, x1 + 22, yA + 12, 130, 52, [
        ("context spans", {"weight": "bold"}),
        ("user / untrusted /", {"color": P.INK_SOFT}),
        ("model · pre-call", {"color": P.INK_SOFT}),
    ])
    sc.add(Path(x1 + 86, yA + 64, pts=[(x1 + 86, yG + 14)], color=P.ACCENT, width=1.5))
    T(sc, x1 + 90, (yA + 64 + yG + 14) / 2 + 3, "ledger write", size=11, color=P.ACCENT)
    card(sc, x1 + 22, yG + 16, 130, 52, [
        ("context ledger", {"weight": "bold"}),
        ("64 events · 256 KB", {"color": P.MONO_FG, "mono": True, "size": 10.5}),
        ("per session · tenant", {"color": P.INK_FAINT}),
    ], stroke=P.ACCENT)

    # 2 — model emits a call; dispatch suspends; POST /check
    x2 = x1 + 160
    step(sc, 2, x2, yA + 4)
    card(sc, x2 + 22, yA + 12, 130, 52, [
        ("emits a tool call", {"weight": "bold"}),
        ("dispatch", {"color": P.FAIL}),
        ("suspended", {"color": P.FAIL}),
    ])
    sc.add(Path(x2 + 86, yA + 64, pts=[(x2 + 86, yG + 12)], color=P.INK_FAINT, width=1.5))
    T(sc, x2 + 90, (yA + 64 + yG + 12) / 2 + 3, "POST /check", size=11, color=P.INK_SOFT, mono=True)

    # 3 — the ordered layers, in one bounded pass
    x3 = x2 + 166
    step(sc, 3, x3 - 4, yG - 2)
    layers = [("id·scope", False), ("extract", False), ("L1", False),
              ("L2", False), ("Lp", True), ("policy", False)]
    lw = 40
    x3b = x3 + 14
    for i, (lab, hot) in enumerate(layers):
        lx = x3b + i * (lw + 4)
        col = P.ACCENT if hot else P.INK
        edge = P.ACCENT if hot else P.STROKE_GROUP
        sc.add(Box(lx, yG + 22, lw, 30, fill=P.WHITE, stroke=edge, radius=5))
        sc.add(Text(lx + lw / 2, yG + 41, lab, size=11, color=col, weight="bold", anchor="middle"))
        if i < len(layers) - 1:
            sc.add(Arrow(lx + lw, yG + 37, lx + lw + 4, yG + 37, color=P.INK_FAINT, width=1.1, head=False))
    T(sc, x3b, yG + 66, "one bounded pass · 0.44 ms median · no model call",
      size=11, color=P.INK_FAINT)

    dx = x3b + len(layers) * (lw + 4) - 4   # right edge of the layer strip

    # 4 — the decision fans out: three return paths, then the trace
    step(sc, 4, dx + 2, yG - 2)

    cxl = dx + 30                       # left edge of the right-hand outcome cards
    cwl = W - 14 - cxl                  # their width, clamped to the canvas

    # allow -> up into the (empty) right of the agent lane, with a receipt
    sc.add(Path(dx + 4, yG + 20, pts=[(dx + 24, yG + 20), (dx + 24, midA - 6)],
                color=P.PASS, width=1.6))
    sc.add(Icon(dx + 30, midA - 22, ICONS["receipt"], size=13, color=P.PASS))
    T(sc, dx + 48, midA - 12, "allow", size=12, color=P.PASS, weight="bold")
    T(sc, dx + 30, midA + 3, "+ Ed25519 receipt", size=11, color=P.PASS)
    T(sc, dx + 30, midA + 17, "executor verifies offline", size=10.5, color=P.INK_FAINT)

    # block -> refusal returned in the slot a result would occupy
    sc.add(Path(dx + 4, yG + 40, pts=[(dx + 10, yG + 40), (dx + 10, midA + 32)],
                color=P.FAIL, width=1.6))
    T(sc, dx + 22, midA + 36, "block", size=12, color=P.FAIL, weight="bold")
    T(sc, dx + 60, midA + 36, "· refusal in the result slot", size=10.5, color=P.INK_FAINT)

    # pending -> down to the reviewer lane
    sc.add(Path(dx + 4, yG + 60, pts=[(dx + 16, yG + 60), (dx + 16, yR + 20)],
                color=P.WARN, width=1.6))
    T(sc, dx + 4, yR + 4, "hold", size=12, color=P.WARN, weight="bold")
    card(sc, cxl, yR + 8, cwl, 38, [
        ("auditor releases what serves", {"color": P.INK}),
        ("the task; person sees the rest", {"color": P.INK_SOFT}),
    ], stroke=P.WARN)

    # 5 — the whole episode becomes a trace, appended to the agent's chain
    sc.add(Path(dx + 4, yG + 76, pts=[(W - 24, yG + 76), (W - 24, yL + 9)],
                color=P.INK_FAINT, width=1.4, dashed=True))
    card(sc, cxl, yL + 5, cwl, 36, [
        ("append trace → SHA-256 chain", {"weight": "bold", "size": 11}),
        ("head → Merkle log / 10 min",
         {"color": P.MONO_FG, "mono": True, "size": 10}),
    ])

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
