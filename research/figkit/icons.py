"""Icon acquisition, ahead of layout.

The workflow this implements: choose icons first, cache them locally,
then compose the figure out of what you have. Composing against a known
set beats asking a generator for "a figure with icons" because the icons
stay identical across figures and across revisions, which is most of what
makes a paper's figures look like one person drew them.

WHY ICONIFY AND NOT FLATICON

Flaticon's free tier requires visible attribution in the work itself and
its licence is awkward for a paper PDF. Iconify serves ~200k icons from
sets whose licences are outright permissive, and it does so over a plain
HTTP API with no key:

    MIT        tabler, lucide, phosphor, ph, mdi-light, octicon
    Apache-2.0 material-symbols, mdi
    CC0        simple-icons
    CC-BY-4.0  fa6-solid  (attribution needed — avoid for papers)

`fetch` refuses sets outside the allowlist so an attribution-encumbered
icon cannot reach a figure by accident.

    https://api.iconify.design/<set>/<name>.svg?color=%23334155

Everything is cached under assets/icons/ and committed. A figure build
must work offline and must produce the same bytes a year from now; a
figure that silently changes because an upstream icon set was updated is
a figure you cannot trust in a camera-ready.
"""

from __future__ import annotations

import re
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "figkit" / "assets" / "icons"

API = "https://api.iconify.design"

# Sets whose licence needs no attribution inside the artwork.
PERMISSIVE_SETS = {
    "tabler": "MIT",
    "lucide": "ISC",
    "ph": "MIT",
    "phosphor": "MIT",
    "mdi": "Apache-2.0",
    "mdi-light": "MIT",
    "material-symbols": "Apache-2.0",
    "octicon": "MIT",
    "simple-icons": "CC0-1.0",
    "carbon": "Apache-2.0",
}

_SAFE = re.compile(r"^[a-z0-9-]+$")


class IconError(RuntimeError):
    pass


def _validate(set_name: str, icon: str) -> None:
    if not _SAFE.match(set_name) or not _SAFE.match(icon):
        raise IconError(f"bad icon id: {set_name}:{icon}")
    if set_name not in PERMISSIVE_SETS:
        raise IconError(
            f"icon set '{set_name}' is not on the permissive allowlist "
            f"({', '.join(sorted(PERMISSIVE_SETS))}). Sets outside it may "
            f"require attribution inside the figure itself."
        )


def fetch(spec: str, color: str = "#334155", *, refresh: bool = False) -> Path:
    """Fetch `set:icon`, cache it, return the local path.

    Colour is baked in at fetch time rather than at render time: an SVG
    whose stroke is set by a parent CSS rule renders correctly in a
    browser and incorrectly in half the PDF toolchain, and the failure is
    silent (black on black, or invisible).
    """
    set_name, _, icon = spec.partition(":")
    _validate(set_name, icon)

    slug = color.lstrip("#").lower()
    dest = CACHE / set_name / f"{icon}--{slug}.svg"
    if dest.exists() and not refresh:
        return dest

    url = f"{API}/{set_name}/{icon}.svg?color={urllib.parse.quote(color)}"
    # The API rejects urllib's default User-Agent with a bare 403, which
    # surfaces as "icon not found" if you don't look at the status code.
    req = urllib.request.Request(url, headers={"User-Agent": "figkit/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read()
    except Exception as e:  # noqa: BLE001
        raise IconError(f"fetch failed for {spec}: {e}") from e

    if not body.lstrip().startswith(b"<svg") or b"404" in body[:120]:
        raise IconError(f"{spec} did not resolve to an icon (set/name typo?)")

    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(body)
    return dest


def inline(spec: str, color: str = "#334155") -> str:
    """The icon's SVG markup with its outer <svg> reduced to a <g>, ready
    to be transplanted into a figure under a translate/scale."""
    raw = fetch(spec, color).read_text()
    inner = re.sub(r"^.*?<svg[^>]*>", "", raw, flags=re.S)
    inner = re.sub(r"</svg>\s*$", "", inner, flags=re.S)
    m = re.search(r'viewBox="([^"]+)"', raw)
    vb = m.group(1) if m else "0 0 24 24"
    return f'<svg viewBox="{vb}" width="100%" height="100%" ' \
           f'preserveAspectRatio="xMidYMid meet">{inner}</svg>'


def png(spec: str, color: str = "#334155", size: int = 128) -> Path:
    """Rasterise for the PowerPoint export, which cannot place SVG."""
    src = fetch(spec, color)
    dest = src.with_suffix(f".{size}.png")
    if dest.exists():
        return dest
    import subprocess
    for cmd in (
        ["rsvg-convert", "-w", str(size), "-h", str(size), "-o", str(dest), str(src)],
        ["cairosvg", str(src), "-o", str(dest), "-W", str(size), "-H", str(size)],
    ):
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            return dest
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue
    raise IconError("need rsvg-convert or cairosvg to rasterise icons")


def prefetch(specs: dict[str, str]) -> dict[str, Path]:
    """Pull a whole icon set up front, before any layout code runs.

    Failures surface here as one list rather than as a half-drawn figure,
    which matters because a missing icon in an SVG is invisible rather
    than loud.
    """
    out, bad = {}, []
    for key, spec in specs.items():
        try:
            colour = "#334155"
            if "@" in spec:
                spec, colour = spec.split("@", 1)
            out[key] = fetch(spec, colour)
        except IconError as e:
            bad.append(f"  {key}: {e}")
    if bad:
        raise IconError("icon prefetch failed:\n" + "\n".join(bad))
    return out


if __name__ == "__main__":
    import sys
    for s in sys.argv[1:]:
        print(fetch(s))
