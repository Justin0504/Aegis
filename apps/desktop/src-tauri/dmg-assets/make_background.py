"""
Generates the DMG installer background for AEGIS.

Two artifacts land next to this script:
  - background.png       (660 x 400,   Finder default)
  - background@2x.png    (1320 x 800,  Retina — Finder auto-picks it)

The layout matches the cmux-style installer Justin referenced:
soft warm cream (matches AEGIS marketing palette), the app icon on
the left, a subtle chevron in the middle, the Applications-folder
drop target on the right. We do NOT draw the icons themselves --
Finder overlays them at the positions declared in tauri.conf.json's
`bundle.macOS.dmg` block. The chevron in the middle is decoration
only, so the icon positions can be tuned without regenerating art.
"""

from PIL import Image, ImageDraw
from pathlib import Path

HERE = Path(__file__).parent

CREAM_TOP    = (243, 236, 220)  # hsl(42 45 91) — matches marketing hero
CREAM_BOTTOM = (232, 222, 200)  # slightly deeper base
CHEVRON      = (180, 160, 120, 130)  # warm ochre, translucent


def gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    w, h = size
    img = Image.new('RGB', size, top)
    px = img.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        r = round(top[0] * (1 - t) + bottom[0] * t)
        g = round(top[1] * (1 - t) + bottom[1] * t)
        b = round(top[2] * (1 - t) + bottom[2] * t)
        for x in range(w):
            px[x, y] = (r, g, b)
    return img


def draw_chevron(img: Image.Image, cx: int, cy: int, scale: int) -> None:
    """Draws a right-pointing chevron centered at (cx, cy), like cmux's arrow."""
    overlay = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    # Two overlapping triangles fudged into a chevron. Thickness = scale/6.
    thick = max(scale // 6, 4)
    # Outer chevron (bigger)
    outer = [
        (cx - scale // 2, cy - scale // 2),
        (cx + scale // 2, cy),
        (cx - scale // 2, cy + scale // 2),
    ]
    d.line(outer, fill=CHEVRON, width=thick, joint='curve')
    img.alpha_composite(overlay)


def build(size: tuple[int, int], out: Path) -> None:
    w, h = size
    bg = gradient(size, CREAM_TOP, CREAM_BOTTOM).convert('RGBA')
    # Chevron sits between the icon slots (left 180, right 480 at 1x).
    chev_cx = w // 2
    chev_cy = h // 2 - int(h * 0.06)   # slightly above center; icon labels sit below
    draw_chevron(bg, chev_cx, chev_cy, scale=int(h * 0.16))
    bg.convert('RGB').save(out, 'PNG', optimize=True)


build((660, 400),  HERE / 'background.png')
build((1320, 800), HERE / 'background@2x.png')
print(f'wrote {HERE / "background.png"}')
print(f'wrote {HERE / "background@2x.png"}')
