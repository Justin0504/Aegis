"""Trim the empty tail of the demo agent's page screenshots.

    python trim_demo.py

shoot_demo.mjs photographs the chat container at a fixed viewport, so a
short turn leaves most of the image blank. This cuts each
images/demo/agent-S*.png to its content (plus a margin), in place. It is a
crop of the bottom only; nothing inside the transcript is touched.
"""
from pathlib import Path

from PIL import Image, ImageChops

IMG = Path(__file__).resolve().parents[1] / "paper-arxiv" / "images" / "demo"


def trim_bottom(path: Path, margin: int = 48) -> tuple[int, int]:
    im = Image.open(path).convert("RGB")
    w, h = im.size
    bg = Image.new("RGB", im.size, im.getpixel((w - 1, h - 1)))
    bbox = ImageChops.difference(im, bg).getbbox()
    if not bbox:
        return h, h
    bottom = min(h, bbox[3] + margin)
    im.crop((0, 0, w, bottom)).save(path)
    return h, bottom


def main() -> None:
    for p in sorted(IMG.glob("agent-S?.png")):
        before, after = trim_bottom(p)
        print(f"{p.name}: {before} -> {after}px")


if __name__ == "__main__":
    main()
