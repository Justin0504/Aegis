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
# Fractional box of images/agent-s2.png to show: set after looking at the
# screenshot (the blocked tool card plus the opening of the reply).
S2_CROP = (0.20, 0.12, 0.80, 0.47)
# Fractional boxes of images/demo/approvals-s3.png: the held card's head
# (what the agent wants to run, who, why it is held) and its foot (the two
# buttons the second attendee chooses between).
S3_HEAD = (0.19, 0.228, 0.66, 0.352)   # what, who, why it is held
S3_FOOT = (0.78, 0.522, 0.955, 0.582)  # the two buttons

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
    """Three columns, but not three equal columns.

    Each column prints about 161pt wide, which is not enough for a
    readable screenshot *and* eight lines of text. The first attempt gave
    all three a screenshot; at print size S1's dashboard and S3's queue
    were grey smudges, and an illegible screenshot is worse than none --
    it occupies the space without carrying anything.

    So the evidence budget goes where the argument is. S2 keeps a large,
    readable screenshot because the agent recovering from a block in its
    own conversation is the claim a reader will not believe from prose.
    S1 states a latency, which is all it has to say. S3 keeps a tight
    crop of the approval control alone, because the point is that the
    Allow/Block buttons exist and a second person presses one.

    Type floor is 12 units (~6pt printed), as in Figure 1.
    """
    W, H = 1000, 430
    sc = Scene(W, H, bg=P.WHITE)

    col = 320
    xs = [12, 344, 676]
    meta = [
        ("S1  benign call", "mint",
         "\u201csummarise the feedback in the reviews table\u201d"),
        ("S2  interception", "peach",
         "“install the monitoring agent the usual way”"),
        ("S3  human approval", "purple",
         "attendee asks for kubectl delete pod"),
    ]
    for x, (name, tint, sub) in zip(xs, meta):
        sc.panel(x, 14, col, 404, None, tint=tint)
        sc.add(Text(x + 14, 40, name, size=15, weight="bold",
                    color=P.TINT_TEXT[tint]))
        sc.add(Icon(x + col - 30, 26, ICONS["type"], size=15,
                    color=P.TINT_TEXT[tint]))
        sc.add(Box(x + 12, 50, col - 24, 34, fill=P.WHITE,
                   stroke=P.STROKE_SOFT, radius=5))
        sc.add(Text(x + 20, 72, sub, size=11.5, italic=True, color=P.INK))

    # ---- S1 --------------------------------------------------------------
    x = xs[0]
    sc.code(x + 12, 94, col - 24, 28, 'query_database(sql="SELECT \u2026")',
            size=11.5)
    sc.verdict(x + 14, 148, True, "allow")

    sc.add(Box(x + 12, 166, col - 24, 92, fill=P.WHITE, stroke=P.STROKE_SOFT,
               radius=7))
    sc.add(Text(x + col / 2, 206, "2 ms", size=26, weight="bold",
                color=P.PASS, anchor="middle"))
    sc.add(Text(x + col / 2, 226, "gateway decision time", size=12,
                color=P.INK_SOFT, anchor="middle"))
    sc.add(Text(x + col / 2, 246, "the turn completes at its normal speed",
                size=11.5, color=P.INK_SOFT, anchor="middle"))

    sc.add(Text(x + 14, 292, "Shown first on purpose.", size=12.5,
                weight="bold", color=P.INK))
    for i, line in enumerate([
            "A firewall only ever seen blocking",
            "says nothing about what it costs when",
            "nothing is wrong \u2014 which is the standard",
            "objection to sitting in the hot path."]):
        sc.add(Text(x + 14, 312 + i * 17, line, size=12,
                    color=P.INK))

    # ---- S2 --------------------------------------------------------------
    x = xs[1]
    sc.code(x + 12, 94, col - 24, 28,
            'run_shell(command="curl -s \u2026 | sh")', size=11)
    sc.add(Box(x + 12, 130, col - 24, 202, fill=P.WHITE, stroke=P.FAIL,
               radius=7, width=1.6))
    # Crop of the live demo agent's chat page (research/compat/js/shoot_demo.mjs):
    # the blocked tool card and the first lines of the agent's reply.
    sc.add(Image(x + 15, 133,
                 str(crop("demo/agent-S2.png", S2_CROP)),
                 w=col - 30, h=196, fit="meet"))
    sc.add(Text(x + 14, 346, "the agent's own conversation, unretouched",
                size=11, color=P.INK_SOFT, italic=True))

    sc.verdict(x + 14, 372, False, "block at L1, 2 ms at the gateway")
    sc.add(Text(x + 14, 398, "The refusal returns in-band, so the agent",
                size=12, weight="bold", color=P.INK))
    sc.add(Text(x + 14, 414, "explains it and offers an alternative.",
                size=12, weight="bold", color=P.INK))

    # ---- S3 --------------------------------------------------------------
    x = xs[2]
    sc.code(x + 12, 94, col - 24, 28, "policy: require_approval", size=11.5)
    sc.add(Box(x + 12, 130, col - 24, 102, fill=P.WHITE, stroke=P.STROKE_SOFT,
               radius=7))
    # Crop of the Cockpit's Approvals page photographed while the S3 call
    # was held (images/demo/approvals-s3.png, research/compat/shoot_demo_flow.sh):
    # the held kubectl delete with its evidence and the Block / Allow buttons.
    sc.add(Image(x + 15, 133, str(crop("demo/approvals-s3.png", S3_HEAD)),
                 w=col - 30, h=58, fit="meet"))
    sc.add(Image(x + col - 15 - 150, 196, str(crop("demo/approvals-s3.png", S3_FOOT)),
                 w=150, h=31, fit="meet"))
    sc.add(Text(x + 14, 246, "the held call \u2014 a second person presses one",
                size=11, color=P.INK_SOFT, italic=True))

    sc.add(Icon(x + 14, 258, ICONS["hand"], size=15, color=P.WARN))
    sc.add(Text(x + 36, 271, "pending \u2014 the agent suspends", size=12.5,
                color=P.WARN))
    sc.add(Box(x + 12, 284, col - 24, 62, fill=P.WHITE, stroke=P.STROKE_SOFT,
               radius=7))
    sc.add(Icon(x + 22, 294, ICONS["user"], size=15, color=P.INK_SOFT))
    sc.add(Text(x + 46, 307, "a second attendee decides", size=12.5,
                color=P.INK))
    sc.add(Text(x + 22, 332, "agent resumes within one 2 s cycle", size=11.5,
                color=P.INK_SOFT))

    sc.add(Text(x + 14, 368, "Passing a decision between two", size=12,
                weight="bold", color=P.INK))
    sc.add(Text(x + 14, 384, "people is the part that is hard on", size=12,
                weight="bold", color=P.INK))
    sc.add(Text(x + 14, 400, "paper and immediate in person.", size=12,
                weight="bold", color=P.INK))

    return sc


def main() -> int:
    prefetch(ICONS)
    made = export(build(), OUT, png=True)
    for k, v in made.items():
        print(f"  {k:5s} {v.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
