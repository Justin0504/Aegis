"""Build an arXiv submission tarball from a LaTeX root.

    python package_for_arxiv.py aegis.tex

WHY THIS IS A SCRIPT AND NOT A COPY COMMAND

The first hand-assembled package was missing images/demo_walkthrough.pdf.
It is referenced from figures/fig_demo.tex, which the root \\input's — so
scanning only the root for \\includegraphics finds every asset except the
ones that are easiest to forget. The build still succeeded in the working
copy, because the file was sitting there; it failed only once the tarball
was unpacked into an empty directory.

So: resolve \\input/\\include transitively, collect assets from every file
reached, refuse to package if anything is unresolved, and verify by
building in a clean directory rather than in the one the sources came
from. A package that only builds where it was made is not a package.

Deliberately does NOT bundle acmart.cls or the .bst. v1 shipped them; the
copy on disk has since gone stale enough to fail the build outright, and
arXiv's TeXLive carries acmart.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

GFX = re.compile(r"\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}")
INP = re.compile(r"\\(?:input|include)\{([^}]+)\}")
ASSET_EXTS = ("", ".pdf", ".png", ".jpg", ".jpeg")
# Only the ROOT document's build products. An earlier version listed
# ".pdf" and swept every figure PDF out of the package with it — the
# tarball still built here, because tectonic had just regenerated them,
# and would have arrived at arXiv without its figures.
JUNK = {".aux", ".log", ".out", ".xdv", ".blg", ".pdf"}


def resolve(root: Path, rel: str, exts: tuple[str, ...]) -> Path | None:
    for e in exts:
        p = root / (rel + e)
        if p.is_file():
            return p
    return None


def collect(root: Path, entry: str) -> tuple[set[Path], set[Path], list[str]]:
    """Everything the document actually needs, found transitively."""
    tex: set[Path] = set()
    assets: set[Path] = set()
    missing: list[str] = []

    def walk(rel: str) -> None:
        p = resolve(root, rel, (".tex", ""))
        if p is None:
            missing.append(rel)
            return
        if p in tex:
            return
        tex.add(p)
        body = p.read_text()
        for g in GFX.findall(body):
            a = resolve(root, g, ASSET_EXTS)
            if a:
                assets.add(a)
            else:
                missing.append(g)
        for i in INP.findall(body):
            walk(i)

    walk(entry)
    return tex, assets, missing


def main() -> int:
    entry = sys.argv[1] if len(sys.argv) > 1 else "aegis.tex"
    root = Path(__file__).resolve().parent
    stem = Path(entry).stem

    tex, assets, missing = collect(root, stem)
    if missing:
        print("MISSING — refusing to package:")
        for m in sorted(set(missing)):
            print("  ", m)
        return 1

    extra = [p for p in (root / "references.bib", root / f"{stem}.bbl") if p.is_file()]
    if not (root / f"{stem}.bbl").is_file():
        # arXiv will run bibtex itself, but shipping the .bbl removes a
        # class of failure that only shows up after upload.
        print(f"note: {stem}.bbl absent — build once with --keep-intermediates")

    with tempfile.TemporaryDirectory() as td:
        stage = Path(td) / "pkg"
        for src in sorted(tex | assets | set(extra)):
            dst = stage / src.relative_to(root)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

        r = subprocess.run(
            ["tectonic", f"{stem}.tex"], cwd=stage, capture_output=True, text=True
        )
        errs = [l for l in r.stderr.splitlines() if l.lower().startswith("error")]
        if errs:
            print("clean-room build FAILED:")
            for e in errs[:6]:
                print("  ", e)
            return 1

        pdf = stage / f"{stem}.pdf"
        pages = subprocess.run(
            ["pdfinfo", str(pdf)], capture_output=True, text=True
        ).stdout
        pages = next(
            (l.split()[-1] for l in pages.splitlines() if l.startswith("Pages")), "?"
        )
        unresolved = subprocess.run(
            ["pdftotext", str(pdf), "-"], capture_output=True, text=True
        ).stdout.count("??")
        print(f"clean-room build OK — {pages} pages, {unresolved} unresolved refs")
        if unresolved:
            print("  refusing: unresolved references would ship as ??")
            return 1

        for f in list(stage.glob(f"{stem}.*")):
            if f.is_file() and f.suffix in JUNK:
                f.unlink()

        out = root / f"{stem}-arxiv.tar.gz"
        with tarfile.open(out, "w:gz") as tar:
            for f in sorted(stage.rglob("*")):
                if f.is_file():
                    tar.add(f, arcname=str(f.relative_to(stage)))

        print(f"\nwrote {out.name} ({out.stat().st_size // 1024} KB)")
        for f in sorted(stage.rglob("*")):
            if f.is_file():
                print("  ", f.relative_to(stage))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
