"""Figure 2 — the demonstration walkthrough.

    python -m figures_src.fig_demo

A demo paper is read by reviewers asking one question: what will someone
standing at this booth actually do, and will they believe it? So the
figure is a timeline of the three scenarios with the real interface at
each step, not another architecture diagram.

Panel (b) carries the most weight and is the reason the layout gives it
the widest slot. The usual objection to pre-execution blocking is that it
breaks the agent; the screenshot shows the agent receiving the refusal
in-band and continuing the conversation, which is an argument no prose
in the paper makes as quickly.

Screenshots are unretouched crops of the shipping Cockpit and of a real
agent session.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from figkit import palette as P                                  # noqa: E402
from figkit.icons import prefetch                                # noqa: E402
from figkit.scene import Box, Icon, Image, Scene, Text, export   # noqa: E402

IMG = ROOT / "paper-arxiv" / "images"
OUT = IMG / "demo_walkthrough"
CROPS = ROOT / "figures_src" / "crops"

ICONS = {
    "ok":      "tabler:circle-check",
    "block":   "tabler:ban",
    "hand":    "tabler:hand-stop",
    "clock":   "tabler:clock",
    "user":    "tabler:users",
    "type":    "tabler:keyboard",
}


def crop(name: str, box: tuple[float, float, float, float]) -> Path:
    """Fractional crop of a screenshot, cached. Cropping only --- a figure
    arguing that the interface really does this cannot retouch it."""
    from PIL import Image as PILImage
    CROPS.mkdir(parents=True, exist_ok=True)
    tag = "-".join(f"{v:.2f}" for v in box)
    dest = CROPS / f"{Path(name).stem}.{tag}.png"
    if dest.exists():
        return dest
    im = PILImage.open(IMG / name).convert("RGB")
    w, h = im.size
    im.crop((int(box[0] * w), int(box[1] * h),
             int(box[2] * w), int(box[3] * h))).save(dest)
    return dest


def build() -> Scene:
    W, H = 1000, 396
    sc = Scene(W, H, bg=P.WHITE)

    col = 320
    xs = [12, 344, 676]
    titles = [
        ("S1  benign call", "mint",
         "“summarise the feedback in the reviews table”"),
        ("S2  interception", "peach",
         "attendee submits input carrying a SQL injection"),
        ("S3  human approval", "purple",
         "attendee asks for kubectl delete pod"),
    ]
    for x, (name, tint, sub) in zip(xs, titles):
        sc.panel(x, 14, col, 368, None, tint=tint)
        sc.add(Text(x + 12, 34, name, size=11, weight="bold",
                    color=P.TINT_TEXT[tint]))
        sc.add(Icon(x + col - 28, 22, ICONS["type"], size=14,
                    color=P.TINT_TEXT[tint]))
        sc.add(Box(x + 10, 42, col - 20, 26, fill=P.WHITE,
                   stroke=P.STROKE_SOFT, radius=5))
        sc.add(Text(x + 18, 59, sub, size=7.6, italic=True, color=P.INK))

    # ---- S1 -------------------------------------------------------------
    x = xs[0]
    sc.code(x + 10, 76, col - 20, 22,
            'query_database(sql="SELECT …")', size=7.2)
    sc.add(Box(x + 10, 104, col - 20, 116, fill=P.WHITE,
               stroke=P.STROKE_SOFT, radius=6))
    sc.add(Image(x + 13, 107, str(crop("session.png", (0.11, 0.09, 1.0, 0.67))),
                 w=col - 26, h=110))
    sc.add(Text(x + 10, 234, "live feed, risk signals, cost", size=7.4,
                color=P.INK_SOFT, italic=True))

    sc.verdict(x + 12, 258, True, "allow")
    sc.add(Box(x + 10, 272, col - 20, 44, fill=P.WHITE, stroke=P.STROKE_SOFT,
               radius=6))
    sc.add(Icon(x + 18, 280, ICONS["clock"], size=13, color=P.INK_SOFT))
    sc.add(Text(x + 38, 291, "~1 ms decision latency", size=8.4, color=P.INK))
    sc.add(Text(x + 18, 308, "the turn completes at its normal speed",
                size=7.4, color=P.INK_SOFT))
    sc.add(Text(x + 10, 336, "Shown first on purpose: a firewall only ever",
                size=7.6, color=P.TINT_TEXT["mint"]))
    sc.add(Text(x + 10, 348, "seen blocking says nothing about its cost",
                size=7.6, color=P.TINT_TEXT["mint"]))
    sc.add(Text(x + 10, 360, "when nothing is wrong.", size=7.6,
                color=P.TINT_TEXT["mint"]))

    # ---- S2 — the widest slot, the real argument ------------------------
    x = xs[1]
    sc.code(x + 10, 76, col - 20, 22,
            'sql="SELECT * … ; DROP TABLE audit_log; --"', size=6.4)
    sc.add(Box(x + 10, 104, col - 20, 150, fill=P.WHITE, stroke=P.FAIL,
               radius=6, width=1.4))
    sc.add(Image(x + 13, 107,
                 str(crop("blockdemo-in-testagent.png", (0.0, 0.02, 1.0, 0.62))),
                 w=col - 26, h=144))
    sc.add(Text(x + 10, 268, "the agent's own conversation, unretouched",
                size=7.4, color=P.INK_SOFT, italic=True))

    sc.verdict(x + 12, 290, False, "block at L1, 6.2 ms")
    sc.add(Box(x + 10, 302, col - 20, 60, fill=P.TINT["peach"],
               stroke=P.TINT_EDGE["peach"], radius=6))
    sc.add(Text(x + 18, 318, "The agent is not broken by the block.",
                size=8.4, weight="bold", color=P.TINT_TEXT["peach"]))
    sc.add(Text(x + 18, 332, "The refusal returns in-band as a tool result,",
                size=7.6, color=P.TINT_TEXT["peach"]))
    sc.add(Text(x + 18, 344, "so the model explains what was blocked and",
                size=7.6, color=P.TINT_TEXT["peach"]))
    sc.add(Text(x + 18, 356, "offers a safe alternative.", size=7.6,
                color=P.TINT_TEXT["peach"]))

    # ---- S3 -------------------------------------------------------------
    x = xs[2]
    sc.code(x + 10, 76, col - 20, 22, "policy: require_approval", size=7.2)
    sc.add(Box(x + 10, 104, col - 20, 116, fill=P.WHITE,
               stroke=P.STROKE_SOFT, radius=6))
    sc.add(Image(x + 13, 107, str(crop("pending.png", (0.11, 0.15, 1.0, 0.73))),
                 w=col - 26, h=110))
    sc.add(Text(x + 10, 234, "approval queue, full arguments visible",
                size=7.4, color=P.INK_SOFT, italic=True))

    sc.add(Icon(x + 12, 250, ICONS["hand"], size=13, color=P.WARN))
    sc.add(Text(x + 32, 261, "pending — the agent suspends", size=8.4,
                color=P.WARN))
    sc.add(Box(x + 10, 272, col - 20, 44, fill=P.WHITE, stroke=P.STROKE_SOFT,
               radius=6))
    sc.add(Icon(x + 18, 280, ICONS["user"], size=13, color=P.INK_SOFT))
    sc.add(Text(x + 38, 291, "a second attendee decides", size=8.4,
                color=P.INK))
    sc.add(Text(x + 18, 308, "agent resumes within one 2 s polling cycle",
                size=7.4, color=P.INK_SOFT))
    sc.add(Text(x + 10, 336, "Passing a decision between two people is",
                size=7.6, color=P.TINT_TEXT["purple"]))
    sc.add(Text(x + 10, 348, "the part that is hard on paper and",
                size=7.6, color=P.TINT_TEXT["purple"]))
    sc.add(Text(x + 10, 360, "immediate in person.", size=7.6,
                color=P.TINT_TEXT["purple"]))

    return sc


def main() -> int:
    prefetch(ICONS)
    made = export(build(), OUT, png=True)
    for k, v in made.items():
        print(f"  {k:5s} {v.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
