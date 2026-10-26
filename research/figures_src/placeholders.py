"""Placeholder figures for the slots Codex will fill (see CODEX-FIGURE-BRIEF.md).

    python -m figures_src.placeholders            # draws every slot that has no file yet
    python -m figures_src.placeholders --force F6 # redraws the named slots

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

TW, CW = "\\textwidth", "\\columnwidth"
SLOTS = {
    # stem: (W, H, title, brief section, printed width)
    # round 2 (CODEX-FIGURE-BRIEF.md) — drawn; kept so --force can restore a box
    "provenance_mechanism": (1000, 560, "Figure: instruction provenance — which turn authorised the call", "§F2", TW),
    "rollout_construction": (1000, 420, "Figure: instantiation by rollout — how the corpus is built", "§F3", TW),
    "audit_chain":          (500, 300, "Figure: signed, chained traces — and what a tamper does", "§F5", CW),
    # round 3 (CODEX-FIGURE-BRIEF-v3.md)
    "cascade":       (1000, 430, "F6: the cascade — what each layer may see, facts → one decision", "v3 §F6", TW),
    "fallback":      (1000, 360, "F7: four failure modes, each with a configured answer", "v3 §F7", TW),
    "judge":         (1000, 420, "F8: the judge — what it reads, and its reliability diagram", "v3 §F8", TW),
    "deployment":    (1000, 440, "F9: deployment — zones, trust boundaries, what crosses them", "v3 §F9", TW),
    "receipts_pins": (500, 330, "F10: receipts and MCP tool pins", "v3 §F10", CW),
    "frontier":      (500, 330, "D1: utility vs attack success, both agent models", "v3 §D1", CW),
    "load":          (500, 300, "D2: one gateway process under load", "v3 §D2", CW),
    "agentdrift":    (500, 300, "D3: AgentDrift flag rates and recall by attack type", "v3 §D3", CW),
    **{f"gallery/{g}": (500, 300, f"{g}: interception card from figdata/gallery.json", "v3 §G", CW)
       for g in ("G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "C1", "C2")},
    "ui/mcp-tools":         (1440, 900, "U1: Settings → MCP tools (capture)", "v3 §U", CW),
    "ui/run-step":          (1440, 900, "U2: run with an expanded step (capture)", "v3 §U", CW),
    "ui/approval-evidence": (1440, 900, "U3: held call with auditor verdict (capture)", "v3 §U", CW),
    "ui/security-360":      (1440, 900, "U4: Security 360 (capture)", "v3 §U", CW),
    "deploy/mcp-host":       (500, 280, "R1: MCP host config + refusal (terminal capture)", "v3 §R", CW),
    "deploy/compose":        (500, 280, "R2: docker compose + an agent run (terminal capture)", "v3 §R", CW),
    "deploy/receipt-verify": (500, 280, "R3: verifying a receipt (terminal capture)", "v3 §R", CW),
}

force = "--force" in sys.argv
named = [a for a in sys.argv[1:] if a != "--force"]
for stem, (W, H, title, sec, width) in SLOTS.items():
    if named and not any(n == stem or title.startswith(n + ":") for n in named):
        continue
    if not force and ((OUT / f"{stem}.pdf").exists() or (OUT / f"{stem}.png").exists()):
        continue
    (OUT / stem).parent.mkdir(parents=True, exist_ok=True)
    sc = Scene(W, H, bg=P.WHITE)
    sc.add(Box(6, 6, W - 12, H - 12, fill=P.PAPER, stroke=P.STROKE, radius=P.RADIUS_PANEL))
    sc.add(Text(W / 2, H / 2 - 14, "PLACEHOLDER — to be drawn by Codex", size=max(14, W / 55),
                weight="bold", anchor="middle", color=P.INK_SOFT))
    sc.add(Text(W / 2, H / 2 + 12, title, size=max(12, W / 70), anchor="middle", color=P.INK_SOFT))
    sc.add(Text(W / 2, H / 2 + 36, f"canvas {W}×{H} units · printed at {width} · spec in CODEX-FIGURE-BRIEF.md {sec}",
                size=max(12, W / 80), anchor="middle", color=P.INK_FAINT, mono=True))
    made = export(sc, OUT / stem, png=True, pptx=False)
    print("  ", made["pdf"])
