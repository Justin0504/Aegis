"""Photography for the marketing site, from Pexels, in one grade.

    python3 scripts/fetch-photos.py     # -> public/images/photo/*.webp + CREDITS.md

scripts/photos.json lists each photo by its Pexels id (chosen by hand);
this script needs no API key -- it downloads each photo's image URL
(recorded from the Pexels search API) from the public CDN.
Pexels licence: free for commercial use, no attribution required. We
keep the credits anyway (public/images/photo/CREDITS.md).

One light grade for all of them so they read as a set: slightly
desaturated, blacks lifted, a warm-green cast toward the page's paper and
sage. Feature panels ("f-*") are kept large; the floating cards ("c-*")
are cut smaller.
"""
from __future__ import annotations

import io
import json
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "images" / "photo"
QS = "?auto=compress&cs=tinysrgb&w={w}"


def grade(im: Image.Image, *, dark: bool = False) -> Image.Image:
    im = ImageEnhance.Color(im).enhance(0.82)
    a = np.asarray(im, dtype=np.float32) / 255.0
    lift = 0.035 if not dark else 0.02
    a = lift + a * (1 - lift - 0.015)                      # lifted blacks, soft whites
    tint = np.array([0.995, 1.008, 0.985], dtype=np.float32)  # a breath of sage
    a = np.clip(a * tint, 0, 1)
    if dark:                                                # closing panel: deep green, out of focus
        ink = np.array([0.06, 0.13, 0.13], dtype=np.float32)
        a = ink + (a ** 1.25) * (np.array([0.42, 0.60, 0.55]) - ink)
    return Image.fromarray((a * 255).astype(np.uint8))


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    photos = json.loads((ROOT / "scripts" / "photos.json").read_text())
    credits = ["# Photo credits", "", "All photographs from [Pexels](https://www.pexels.com/license/) "
               "(free for commercial use; attribution not required, given here anyway).", ""]
    for p in photos:
        big = p["name"].startswith("f-")
        w = 1500 if big else 900
        req = urllib.request.Request(p["src"] + QS.format(w=w), headers={"User-Agent": "aegis-site/1.0"})
        im = Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=60).read())).convert("RGB")
        im.thumbnail((w, 1800 if big else 1350))
        dark = p["name"] == "f-fern"
        im = grade(im, dark=dark)
        if dark:
            im = im.filter(ImageFilter.GaussianBlur(6))
        dest = OUT / f"{p['name']}.webp"
        im.save(dest, "WEBP", quality=74 if big else 72, method=6)
        credits.append(f"- `{p['name']}.webp` — {p['by']}, <{p['page']}>")
        print(f"  {dest.name:22s} {im.size[0]}x{im.size[1]}  {dest.stat().st_size // 1024:4d} KB")
    (OUT / "CREDITS.md").write_text("\n".join(credits) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
