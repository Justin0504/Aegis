"""Figure 1 — the control point, what comes back from it, and what stands around it.

    python -m figures_src.fig_architecture      # → paper-arxiv/images/architecture.{svg,pdf,png,pptx}

Two rows (CODEX-FIGURE-BRIEF.md §F1). Row 1 is the path of one call:
the agent, the three ways in (SDK, MCP proxy, egress proxy), the five
gateway stages ordered by what each may observe, the three decisions,
and the three return paths drawn explicitly — because a mediation
layer is defined by what comes *back* from it, and the single claim the
demonstration rests on is that a block returns in-band. Row 2 is the
systems around the call that make it deployable rather than
demonstrable: audit, behavioural monitoring, containment and recovery,
pre-deploy scanning, connectors and fallback (§2.4–§2.10).

No evaluation numbers appear here; they belong in §4's tables. Type
floor is 12 units on the 1000-wide canvas (≈6 pt printed); the few
10.5–11-unit labels are chips and notes a reader can skip.
"""

from __future__ import annotations

import sys
from pathlib import Path as FsPath

ROOT = FsPath(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from figkit import palette as P                                       # noqa: E402
from figkit.icons import prefetch                                     # noqa: E402
from figkit.scene import Arrow, Box, Icon, Path, Scene, Text, export  # noqa: E402

OUT = ROOT / "paper-arxiv" / "images" / "architecture"

ICONS = {
    "agent":  "tabler:robot",
    "regex":  "tabler:regex",
    "tree":   "tabler:binary-tree",
    "route":  "tabler:route",
    "brain":  "tabler:bulb",
    "scale":  "tabler:scale",
    "user":   "tabler:user-check",
    "lock":   "tabler:lock-check",
    "chart":  "tabler:chart-line",
    "stop":   "tabler:hand-stop",
    "scan":   "tabler:shield-half",
    "plug":   "tabler:plug-connected",
}


def numbered(sc: Scene, x: float, y: float, n: str):
    """A circled step number, for the points where a person acts."""
    sc.add(Box(x, y, 15, 15, fill=P.INK, stroke=P.INK, radius=7.5))
    sc.add(Text(x + 7.5, y + 11, n, size=15, weight="bold", color=P.WHITE, anchor="middle"))


def build() -> Scene:
    W, H = 1000, 508
    sc = Scene(W, H, bg=P.WHITE)

    AG_X, AG_W = 12, 148
    ST_X, ST_W = 168, 82          # interposition stubs
    GW_X, GW_W = 258, 548
    Y0 = 36                        # row 1 top

    # ---- agent ----------------------------------------------------------
    sc.panel(AG_X, Y0, AG_W, 218, "Agent", tint="slate", title_size=15)
    sc.card(AG_X + 12, Y0 + 32, AG_W - 24, 34, "LLM", size=13, icon=ICONS["agent"])
    sc.add(Text(AG_X + 14, Y0 + 86, "untrusted principal", size=11.5, color=P.INK_SOFT, italic=True))
    sc.add(Box(AG_X + 12, Y0 + 98, AG_W - 24, 56, fill=P.WHITE, stroke=P.ACCENT_SOFT, radius=6))
    sc.add(Icon(AG_X + 20, Y0 + 108, ICONS["plug"], size=14, color=P.ACCENT))
    sc.add(Text(AG_X + 42, Y0 + 120, "two lines", size=12.5, weight="bold", color=P.ACCENT))
    sc.add(Text(AG_X + 18, Y0 + 144, "agentguard.auto()", size=10.8, mono=True, color=P.MONO_FG))
    sc.add(Text(AG_X + 14, Y0 + 176, "15 frameworks", size=12, color=P.INK_SOFT))
    sc.add(Text(AG_X + 14, Y0 + 194, "Python · JS · Go", size=11.5, color=P.INK_FAINT))
    numbered(sc, AG_X + AG_W - 26, Y0 + 6, "1")

    # ---- three ways in ----------------------------------------------------
    stubs = [("SDK auto()", False, Y0 + 40), ("MCP proxy", True, Y0 + 72), ("egress proxy", True, Y0 + 104)]
    sc.add(Text(ST_X, Y0 + 26, "three ways in", size=11, color=P.INK_FAINT))
    for label, dashed, y in stubs:
        sc.add(Box(ST_X, y, ST_W, 20, fill=P.WHITE, stroke=P.STROKE_GROUP if dashed else P.INK,
                   radius=4, dashed=dashed, width=1.0))
        sc.add(Text(ST_X + ST_W / 2, y + 14, label, size=10.5, mono=True,
                    color=P.INK_SOFT if dashed else P.INK, anchor="middle"))
        sc.add(Arrow(ST_X + ST_W + 2, y + 10, GW_X - 3, y + 10, color=P.INK_FAINT, width=1.2,
                     dashed=dashed))
    sc.add(Arrow(AG_X + AG_W + 3, Y0 + 50, ST_X - 3, Y0 + 50, color=P.INK_FAINT, width=1.4))
    sc.add(Text(ST_X, Y0 + 142, "proxies decide", size=10.5, color=P.INK_FAINT))
    sc.add(Text(ST_X, Y0 + 155, "inline; no hold", size=10.5, color=P.INK_FAINT))

    # ---- gateway --------------------------------------------------------
    sc.add(Box(GW_X, Y0, GW_W, 218, fill=P.PAPER, stroke=P.STROKE_GROUP, radius=12, dashed=True))
    sc.add(Text(GW_X + 16, Y0 + 26, "Aegis Gateway", size=17, weight="bold"))
    sc.add(Text(GW_X + 150, Y0 + 26, "the call has not run yet", size=12, color=P.INK_SOFT, italic=True))
    sc.add(Text(GW_X + GW_W - 16, Y0 + 26, "layers ordered by what they may observe", size=11,
                color=P.INK_FAINT, anchor="end"))

    lw, lg = 100, 6
    lx0 = GW_X + 12
    cy = Y0 + 40
    layers = [
        # name, icon, sees, cost, style  (style: solid | accent | dashed)
        ("L1  rules",      ICONS["regex"], "call string",   "<1 ms",        "solid"),
        ("L2  behaviour",  ICONS["tree"],  "agent history", "in-process",   "solid"),
        ("Lp provenance", ICONS["route"], "channel split", "<1 ms",        "accent"),
        ("L3  auditor",    ICONS["brain"], "stated task",   "1–2 s",   "dashed"),
        ("Policy DSL",     ICONS["scale"], "all facts",     "constant",     "solid"),
    ]
    for i, (name, icon, sees, cost, style) in enumerate(layers):
        x = lx0 + i * (lw + lg)
        stroke = {"solid": P.STROKE_GROUP, "accent": P.ACCENT, "dashed": P.STROKE_GROUP}[style]
        lead = P.ACCENT if style == "accent" else P.INK
        sc.add(Box(x, cy, lw, 112, fill=P.WHITE, stroke=stroke, radius=8,
                   dashed=style != "solid", width=1.2 if style == "accent" else 1.0))
        sc.add(Icon(x + lw - 22, cy + 90, icon, size=13, color=lead))
        sc.add(Text(x + 10, cy + 21, name, size=11.5, weight="bold", color=lead))
        sc.add(Box(x + 8, cy + 34, lw - 16, 22, fill=P.MONO_BG, stroke=P.STROKE_SOFT, radius=4))
        sc.add(Text(x + lw / 2, cy + 49, sees, size=10.5, mono=True, color=P.INK, anchor="middle"))
        sc.add(Text(x + 10, cy + 76, cost, size=11.5, color=P.ACCENT if style == "accent" else P.INK_SOFT))
        note = {"Lp provenance": "session ledger",
                "L3  auditor": "pre / post check",
                "Policy DSL": "tightens only",
                "L2  behaviour": "never relaxes",
                "L1  rules": "28 patterns"}[name]
        sc.add(Text(x + 10, cy + 94, note, size=10.5, color=P.INK_FAINT))
        if i < 4:
            sc.add(Arrow(x + lw + 1, cy + 45, x + lw + lg - 1, cy + 45, color=P.INK_FAINT, width=1.2, head=False))

    # ---- decisions ------------------------------------------------------
    dy = Y0 + 168
    sc.add(Text(GW_X + 16, dy + 21, "decision", size=13, weight="bold", color=P.INK))
    pills = [(GW_X + 92, 92, "allow", P.PASS_SOFT, P.PASS),
             (GW_X + 196, 92, "block", P.FAIL_SOFT, P.FAIL),
             (GW_X + 300, 104, "pending", P.WARN_SOFT, P.WARN)]
    for x, w, label, fill, fg in pills:
        sc.add(Box(x, dy, w, 32, fill=fill, stroke=fill, radius=16))
        sc.add(Text(x + w / 2, dy + 21, label, size=13, weight="bold", color=fg, anchor="middle"))
    sc.add(Arrow(GW_X + 410, dy + 16, GW_X + 428, dy + 16))
    sc.card(GW_X + 432, dy, 110, 32, "human approval", size=11.5, icon=ICONS["user"])
    numbered(sc, GW_X + 432 + 110 - 10, dy - 8, "2")

    # ---- return paths ----------------------------------------------------
    ry = Y0 + 218
    for sx, ly, ex, col, wd, dash in [
        (GW_X + 138, ry + 28, AG_X + 74, P.PASS, 1.8, False),
        (GW_X + 242, ry + 46, AG_X + 98, P.FAIL, 2.2, False),
        (GW_X + 352, ry + 64, AG_X + 50, P.WARN, 1.8, True),
    ]:
        sc.add(Path(sx, dy + 34, pts=[(sx, ly), (ex, ly), (ex, ry + 4)], color=col, width=wd, dashed=dash))

    LX, LY, LW = 640, ry + 8, 348
    sc.add(Box(LX, LY, LW, 86, fill=P.WHITE, stroke=P.STROKE_SOFT, radius=8))
    for i, (col, tag, txt) in enumerate([
        (P.PASS, "allow", "the tool runs; its result returns normally"),
        (P.FAIL, "block", "the tool never runs — a refusal returns"),
        (P.WARN, "pending", "the turn suspends until a person decides"),
    ]):
        y = LY + 22 + i * 24
        sc.add(Text(LX + 12, y, tag, size=12, weight="bold", color=col))
        sc.add(Text(LX + 78, y, txt, size=11.5, color=P.INK))
    sc.add(Text(LX + 78, LY + 58, "where a tool result would", size=11.5, color=P.INK))

    sc.add(Text(AG_X, ry + 110, "The refusal arrives in-band — which is why a blocked agent "
                "explains itself and continues the conversation instead of failing.",
                size=12.5, weight="bold", color=P.INK))

    # ---- row 2: the systems around the call ----------------------------
    R2 = ry + 124
    cw, cg = 187, 10
    cards = [
        ("Behavioural monitoring", ICONS["chart"], ["profile \u00b7 sliding window",
                                                   "IForest \u00b7 HST \u00b7 Mahalanobis",
                                                   "ADWIN drift \u00b7 conformal p-values"], False),
        ("Containment & recovery", ICONS["stop"], ["kill switch (violation count)",
                                                  "budget guard \u00b7 effect outbox",
                                                  "snapshot \u2192 saga \u2192 rollback"], False),
        ("Pre-deploy", ICONS["scan"], ["repo scan \u00b7 53 OWASP rules",
                                       "same policy packs, statically",
                                       "code shield \u00b7 scan diff"], False),
        ("Connectors & fallback", ICONS["plug"], ["SIEM \u00b7 OTLP \u00b7 webhooks \u00b7 SSO",
                                                 "fail open | closed \u00b7 disk queue",
                                                 "offline model \u00b7 AEGIS_OFFLINE"], False),
        ("Audit & integrity", ICONS["lock"], ["Ed25519 per-agent signature",
                                             "SHA-256 chain \u2192 Merkle \u2192 log",
                                             "witnesses \u00b7 offline verifier"], True),
    ]
    for i, (title, icon, items, badge) in enumerate(cards):
        x = AG_X + i * (cw + cg)
        sc.add(Box(x, R2, cw, 92, fill=P.WHITE, stroke=P.STROKE, radius=8))
        sc.add(Icon(x + 10, R2 + 10, icon, size=14, color=P.INK_SOFT))
        sc.add(Text(x + 30, R2 + 22, title, size=12.5, weight="bold", color=P.INK))
        for j, it in enumerate(items):
            sc.add(Text(x + 12, R2 + 44 + j * 16, it, size=11, color=P.INK_SOFT))
        if badge:
            numbered(sc, x + cw - 24, R2 + 6, "3")
    # every decision, signed → audit (down the right edge, clear of the lanes)
    sc.add(Path(GW_X + GW_W + 2, Y0 + 60, pts=[(W - 6, Y0 + 60), (W - 6, R2 + 46), (AG_X + 4 * (cw + cg) + cw + 3, R2 + 46)],
                color=P.INK_FAINT, width=1.2, dashed=True, radius=6))
    sc.add(Text(GW_X + GW_W + 8, Y0 + 54, "every decision, signed", size=10.5, color=P.INK_FAINT))

    # ---- attendee legend -------------------------------------------------
    ay = R2 + 112
    sc.add(Text(AG_X, ay, "Where an attendee acts:", size=12, weight="bold", color=P.INK))
    for x, t in [(190, "1  drives the agent"), (350, "2  approves or blocks a held call"),
                 (594, "3  tampers with the signed log, verification fails")]:
        sc.add(Text(x, ay, t, size=12, color=P.INK_SOFT))
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
