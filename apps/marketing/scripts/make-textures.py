"""Textures for the marketing site, in the site's own palette.

    python3 scripts/make-textures.py      # -> public/images/tex-*.jpg

The page's photography is graded, not sourced: each existing image in
public/images is gradient-mapped onto the ink -> sage -> paper ramp so it
reads as one set, with film grain so large flat areas do not band. The
water texture behind the closing call to action is generated, so the
site carries no stock imagery it would have to license or attribute.
Deterministic (fixed seeds): re-running produces the same bytes.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
IMG = ROOT / "public" / "images"

# ink -> deep green -> accent -> sage -> mist -> paper
RAMP = ["#0c1a1b", "#152b2d", "#24473c", "#2d5a4a", "#577b6d", "#9fb4a7", "#dfe5dc", "#f2efea"]


def _hex(c: str) -> np.ndarray:
    return np.array([int(c[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float32)


def gradient_map(lum: np.ndarray, ramp=RAMP, lo=0.0, hi=1.0) -> np.ndarray:
    """Map luminance in [0,1] onto the ramp, restricted to [lo, hi] of it."""
    stops = np.stack([_hex(c) for c in ramp])
    t = lo + np.clip(lum, 0, 1) * (hi - lo)
    pos = t * (len(ramp) - 1)
    i = np.clip(np.floor(pos).astype(int), 0, len(ramp) - 2)
    f = (pos - i)[..., None]
    return stops[i] * (1 - f) + stops[i + 1] * f


def grain(rgb: np.ndarray, sigma: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = rng.normal(0, sigma, rgb.shape[:2])[..., None]
    return np.clip(rgb + n, 0, 255)


def save(rgb: np.ndarray, name: str, quality=84) -> None:
    out = IMG / name
    Image.fromarray(rgb.astype(np.uint8)).save(out, "JPEG", quality=quality, optimize=True, progressive=True)
    print(f"  {name:22s} {out.stat().st_size // 1024:4d} KB")


def grade(src: str, name: str, *, lo: float, hi: float, gamma=1.0, width=1600, seed=1) -> None:
    im = Image.open(IMG / src).convert("RGB")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    a = np.asarray(im, dtype=np.float32) / 255.0
    lum = (0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2])
    lum = (lum - lum.min()) / max(1e-6, lum.max() - lum.min())
    rgb = gradient_map(lum ** gamma, lo=lo, hi=hi)
    save(grain(rgb, 5.0, seed), name, quality=78)


def _field(x, y, rng, n=7, base=1.2):
    """A smooth random field: a sum of randomly oriented sinusoids."""
    v = np.zeros_like(x)
    amp, k = 1.0, base
    for _ in range(n):
        th, ph = rng.uniform(0, np.pi), rng.uniform(0, 2 * np.pi)
        v += amp * np.sin(k * (x * np.cos(th) + y * np.sin(th)) + ph)
        amp *= 0.55
        k *= 1.9
    return v


def _norm(v):
    return (v - v.min()) / (v.max() - v.min())


def water(name: str, w=1800, h=1100, seed=7) -> None:
    """Wind on dark water: many thin, roughly parallel ripple crests, visible
    only where a gust touches the surface, under a slow sky reflection."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    x, y = x / w * 6.0, y / w * 6.0
    # Horizontal lines, bent by a smooth field that varies faster across
    # the lines than along them --- the anisotropy is what reads as water.
    q = y + 0.16 * _field(x * 0.7, y * 2.4, rng, n=5, base=1.1) \
          + 0.035 * _field(x * 3.0, y * 6.0, rng, n=3, base=1.5)
    lines = np.sin(2 * np.pi * 7.5 * q + 1.4 * _field(x * 0.5, y * 1.5, rng, n=4))
    crest = (0.5 + 0.5 * lines) ** 4                       # thin bright crests
    gust = _norm(_field(x * 0.45, y * 0.9, rng, n=4, base=1.0)) ** 1.6
    sky = _norm(_field(x * 0.22, y * 0.22, rng, n=3, base=0.8))
    sky = 0.6 * sky + 0.4 * (1 - y / y.max())             # brighter toward the horizon
    lum = 0.10 + 0.34 * sky + 0.38 * crest * (0.15 + gust)
    rgb = gradient_map(np.clip(lum, 0, 1), lo=0.02, hi=0.7)
    im = Image.fromarray(rgb.astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.9))
    save(grain(np.asarray(im, dtype=np.float32), 6.0, seed), name, quality=82)


def main() -> int:
    grade("wavy-architecture.jpg", "tex-wave.jpg", lo=0.05, hi=0.78, gamma=0.9, seed=2)
    grade("metal-detail.jpg", "tex-metal.jpg", lo=0.0, hi=0.7, gamma=0.85, seed=3)
    grade("beams-light.jpg", "tex-beams.jpg", lo=0.35, hi=1.0, gamma=0.8, seed=4)
    water("tex-water.jpg")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
