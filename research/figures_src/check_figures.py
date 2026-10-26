"""Deterministic acceptance checks for every figure slot (CODEX-FIGURE-BRIEF-v3.md).

    python -m figures_src.check_figures            # all slots
    python -m figures_src.check_figures F6 gallery/G1

Exit status 1 if any slot fails. Per slot:

  exists        the file the LaTeX includes is there
  replaced      it is not still the placeholder (text "PLACEHOLDER", or the
                PNG hash recorded in figdata/placeholders.json)
  aspect        page / image aspect within 3 % of the slot's canvas, so the
                page layout the paper was built with does not move
  fonts         every font in the PDF is embedded (pdffonts)
  print size    smallest word, scaled to the printed width, is >= 5 pt
                (the brief's floor is 6 pt; 5 leaves room for bbox slack)
  numbers       every number printed in the figure occurs in figdata/*.json,
                figdata/captures/*, the paper's sources or the v3 brief
  verbatim      gallery cards contain their record's tool name and the
                first words of its reason, exactly

What it cannot judge — collisions, legibility, whether the figure says
what the brief asks — still needs a look at the rendered page.
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

R = Path(__file__).resolve().parent.parent
PA = R / "paper-arxiv"
IMG = PA / "images"
FD = PA / "figdata"
sys.path.insert(0, str(R))
from figures_src.placeholders import SLOTS  # noqa: E402

# Numbers a figure may print that are not in the result files, each with
# where it comes from (e.g. a worked example computed on one record).
# Add an entry only with a source a reader could re-run.
_SOURCED = json.loads((FD / "sourced_numbers.json").read_text()) if (FD / "sourced_numbers.json").exists() else {}

PRINTED_PT = {"\\textwidth": 506.3, "\\columnwidth": 241.1}   # acmart sigconf
NUM = re.compile(r"(?<![\w.])\d+(?:[.,]\d+)*")


# Data plots print axis ticks; a round tick value is not a claim.
PLOTS = {"capability", "frontier", "load", "agentdrift", "judge"}


def _is_tick(tok: str) -> bool:
    try:
        v = float(tok.replace(",", ""))
    except ValueError:
        return False
    return any(abs(v / step - round(v / step)) < 1e-9 for step in (0.05, 0.25, 5, 10, 25, 100, 500, 1000))


def _run(*cmd: str) -> str:
    return subprocess.run(cmd, capture_output=True, text=True).stdout


def _norm(tok: str) -> str:
    t = tok.replace(",", "")
    return t.rstrip("0").rstrip(".") if "." in t else t


def _allowed_numbers() -> set[str]:
    texts = [p.read_text(errors="ignore") for p in
             [PA / "aegis.tex", PA / "CODEX-FIGURE-BRIEF-v3.md", PA / "CODEX-FIGURE-BRIEF.md",
              *(PA / "sections").glob("*.tex"), *(PA / "figures").glob("*.tex"), *(FD / "captures").glob("*")]
             if p.is_file()]
    allowed = {_norm(t) for txt in texts for t in NUM.findall(txt)}

    def walk(v):
        if isinstance(v, dict):
            if {"num", "den"} <= v.keys() and v["den"]:
                allowed.update({str(v["num"]), str(v["den"])})
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, bool) or v is None:
            return
        elif isinstance(v, (int, float)):
            allowed.add(_norm(str(v)))
            for d in (0, 1, 2):
                allowed.add(_norm(f"{v:.{d}f}"))
                if 0 < v <= 1:
                    allowed.add(_norm(f"{100 * v:.{d}f}"))
        elif isinstance(v, str):
            allowed.update(_norm(t) for t in NUM.findall(v))
    for f in FD.glob("*.json"):
        walk(json.loads(f.read_text()))
    return allowed


def _min_word_pt(pdf: Path, printed: float) -> float | None:
    html = _run("pdftotext", "-bbox", str(pdf), "-")
    page = re.search(r'<page width="([\d.]+)"', html)
    words = re.findall(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">', html)
    if not page or not words:
        return None
    scale = printed / float(page.group(1))
    return min((float(y1) - float(y0)) * scale for _, y0, y1 in words)


def check(stem: str, spec, allowed: set[str], gallery: dict) -> list[tuple[str, bool, str]]:
    W, H, title, sec, width = spec
    pdf, png = IMG / f"{stem}.pdf", IMG / f"{stem}.png"
    is_png_slot = stem.startswith("ui/")
    f = png if is_png_slot else pdf
    out = []
    if not f.exists():
        return [("exists", False, f"missing {f.relative_to(PA)}")]
    out.append(("exists", True, str(f.relative_to(PA))))
    marks = json.loads((FD / "placeholders.json").read_text()) if (FD / "placeholders.json").exists() else {}
    text = "" if is_png_slot else _run("pdftotext", "-layout", str(pdf), "-")
    still = ("PLACEHOLDER" in text) or (png.exists() and marks.get(stem) == hashlib.sha256(png.read_bytes()).hexdigest())
    out.append(("replaced", not still, "still the placeholder" if still else "ok"))
    if still:
        return out

    if is_png_slot:
        from PIL import Image
        w, h = Image.open(png).size
    else:
        m = re.search(r"Page size:\s+([\d.]+) x ([\d.]+)", _run("pdfinfo", str(pdf)))
        w, h = float(m.group(1)), float(m.group(2))
    ratio = (w / h) / (W / H)
    out.append(("aspect", abs(ratio - 1) <= 0.03, f"{w:.0f}x{h:.0f} vs canvas {W}x{H} ({ratio:.3f})"))
    if is_png_slot:
        out.append(("resolution", w >= 1440, f"{w}px wide"))
        return out

    rows = _run("pdffonts", str(pdf)).splitlines()
    col = rows[0].index("emb") if rows else 0
    fonts = [(l[:36].strip(), l[col:col + 3].strip()) for l in rows[2:] if l.strip()]
    bad = [n for n, emb in fonts if emb != "yes"]
    out.append(("fonts", not bad, "all embedded" if not bad else f"not embedded: {bad}"))
    stray = sorted({n.split("+")[-1] for n, _ in fonts if n != "[none]" and "Geist" not in n})
    if stray:   # a glyph Geist lacks fell back to a system font: legal, but say so
        print(f"      ! {stem}: fallback font(s) {', '.join(stray)} — a glyph is missing from Geist")

    mn = _min_word_pt(pdf, PRINTED_PT[width])
    out.append(("print size", mn is None or mn >= 5.0, "no text" if mn is None else f"smallest word {mn:.1f} pt printed"))

    extra = {_norm(str(n)) for n in _SOURCED.get(stem, {}).get("numbers", [])}
    plot = stem in PLOTS
    strays = sorted({t for t in NUM.findall(text) if _norm(t) not in allowed | extra
                     and not (t.isdigit() and int(t) <= 12) and not (plot and _is_tick(t))})
    out.append(("numbers", not strays, "all sourced" if not strays else f"unsourced: {', '.join(strays[:12])}"))

    gid = stem.split("/")[-1]
    if stem.startswith("gallery/") and gid in gallery:
        rec = gallery[gid]
        flat = re.sub(r"\s+", " ", text)
        need = [rec["tool"]] + ([" ".join(rec["reason"].split()[:6])] if rec.get("reason") else [])
        miss = [n for n in need if n and n not in flat]
        out.append(("verbatim", not miss, "ok" if not miss else f"missing: {miss}"))
    return out


def _gallery_picks() -> dict:
    g = json.loads((FD / "gallery.json").read_text())
    picks = {}
    for c in g["refused"]:
        if c.get("pick"):
            picks[c["pick"]] = {"tool": c["call"]["tool"], "reason": c["reason"]}
    for c in g["landed"]:
        if c.get("pick"):
            picks[c["pick"]] = {"tool": c["calls"][-1]["tool"], "reason": None}
    for c in g["compat"]:
        d = next((d for d in c["decisions"] if d["decision"] == "block"), None)
        if d:
            picks[c["pick"]] = {"tool": d["tool"], "reason": d.get("dsl_rule") or d.get("reason")}
    cap = FD / "captures" / "g9_run2.json"
    if cap.exists():
        picks["G9"] = {"tool": "get_weather", "reason": "changed after it was approved"}
    return picks


def main(argv: list[str]) -> int:
    allowed, gallery = _allowed_numbers(), _gallery_picks()
    fails = 0
    for stem, spec in SLOTS.items():
        if argv and not any(a == stem or spec[2].startswith(a + ":") for a in argv):
            continue
        res = check(stem, spec, allowed, gallery)
        ok = all(r[1] for r in res)
        fails += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {stem}")
        for name, good, note in res:
            if not good:
                print(f"      ✗ {name}: {note}")
    print(f"\n{fails} slot(s) failing")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
