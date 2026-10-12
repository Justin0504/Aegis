"""Evaluation figure — what each layer can separate, and at what cost.

    python -m figures_src.fig_capability     # → paper-arxiv/images/capability.{pdf,png}

Two panels, numbers copied from Tables tab:results and tab:provenance
(paper-arxiv/figures/table_results.tex, table_provenance.tex); if those
tables change, change the dicts below — nothing here is recomputed.

 (a) detectors on the instantiated corpus: balanced accuracy against P50
     latency. Every content-only detector sits on the chance line; only
     the judge, which reads the task, is above it — at 2,280 ms.
 (b) feature blocks on the two-step benign arm (5-fold CV AUC ± sd):
     content and taint are inside each other's spread; grounded
     instruction provenance is the step; the adaptive attacker lowers it
     to 0.933, not to the content level.
"""
from __future__ import annotations

import glob
import os
import sys
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib import font_manager as fm

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from figkit import palette as P  # noqa: E402

for f in glob.glob(os.path.expanduser("~/Library/Fonts/Geist*.ttf")):
    try:
        fm.fontManager.addfont(f)
    except Exception:
        pass
mpl.rcParams.update({
    "font.family": ["Geist", "Inter", "Helvetica Neue", "Arial", "sans-serif"], "font.size": 7.5,
    "axes.titlesize": 8, "axes.labelsize": 7.5, "xtick.labelsize": 7, "ytick.labelsize": 7,
    "legend.fontsize": 6.5, "legend.frameon": False, "axes.edgecolor": P.INK_SOFT, "axes.linewidth": 0.6,
    "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "grid.color": P.STROKE,
    "grid.linewidth": 0.5, "axes.axisbelow": True, "xtick.color": P.INK_SOFT, "ytick.color": P.INK_SOFT,
    "savefig.bbox": "tight", "savefig.pad_inches": 0.02, "pdf.fonttype": 42,
})
OUT = Path(__file__).resolve().parent.parent / "paper-arxiv" / "images" / "capability"

# (a) Table tab:results — detector, balanced accuracy, P50 ms
DETECTORS = [
    ("no defense",        0.500,    0.0),
    ("keyword blacklist", 0.499,    0.0),
    ("AEGIS rules (L1)",  0.552,    1.4),
    ("patterns only",     0.499,    1.4),
    ("LLM judge (L3)",    0.851, 2280.4),
]
# (b) Table tab:provenance — block, AUC, sd, role
BLOCKS = [
    ("content (15)",                 0.687, 0.116, "content"),
    ("data provenance / taint (5)",  0.737, 0.091, "content"),
    ("instruction provenance,\ngrounded (4)", 0.991, 0.009, "proposed"),
    ("+ taint (9)",                  0.991, 0.009, "proposed"),
    ("+ content (19)",               0.986, 0.013, "proposed"),
    ("definitional (2), excluded",   0.822, 0.129, "excluded"),
]
ADAPTIVE = ("adaptive attacker\n(user vocabulary in args)", 0.933, 0.024)

COLW = 3.33  # \columnwidth of acmart sigconf, inches
fig, (a, b) = plt.subplots(1, 2, figsize=(2 * COLW * 1.02, 1.55), constrained_layout=True,
                           gridspec_kw={"width_ratios": [1, 1.25]})

# ── (a)
a.axhline(0.5, color=P.INK_FAINT, lw=0.6, ls=":")
a.text(60, 0.507, "chance", fontsize=6, color=P.INK_FAINT)
OFFS = {"no defense": (5, 7, "left"), "keyword blacklist": (5, -15, "left"),
        "AEGIS rules (L1)": (5, 5, "left"), "patterns only": (5, -7, "left"), "LLM judge (L3)": (0, 7, "center")}
for name, acc, ms in DETECTORS:
    x = max(ms, 0.3)
    col = P.ACCENT if "judge" in name else P.INK_SOFT
    a.scatter(x, acc, s=16, color=col, zorder=3)
    dx, dy, ha = OFFS[name]
    a.annotate(name, (x, acc), xytext=(dx, dy), textcoords="offset points",
               fontsize=6.3, color=col, ha=ha, va="center")
a.set_xscale("log")
a.set_xlim(0.2, 9000); a.set_ylim(0.44, 0.92)
a.set_xticks([1, 10, 100, 1000]); a.set_xticklabels(["1", "10", "100", "1,000"])
a.set_xlabel("P50 latency per call (ms, log)")
a.set_ylabel("balanced accuracy")
a.set_title("(a) detectors on agent-emitted attacks")

# ── (b)
names = [n for n, *_ in BLOCKS]
ys = list(range(len(BLOCKS)))[::-1]
for y, (name, auc, sd, role) in zip(ys, BLOCKS):
    col = {"content": P.INK_SOFT, "proposed": P.ACCENT, "excluded": P.INK_FAINT}[role]
    b.barh(y, auc, 0.6, color=col, alpha=0.35 if role == "excluded" else 0.9,
           hatch="////" if role == "excluded" else None, edgecolor=col, lw=0.4)
    b.errorbar(auc, y, xerr=sd, fmt="none", ecolor=P.INK, elinewidth=0.6, capsize=1.8)
    b.text(min(auc + sd + 0.012, 1.17), y, f"{auc:.3f}", va="center", fontsize=6.3, color=P.INK)
# adaptive attacker marker on the grounded row; explained in a legend, off the bars
from matplotlib.lines import Line2D
yg = ys[2]
b.scatter(ADAPTIVE[1], yg, marker="v", s=18, color=P.FAIL, zorder=4)
b.legend(handles=[Line2D([], [], marker="v", color=P.FAIL, lw=0, ms=4,
                         label=f"adaptive attacker\n(user words in args): {ADAPTIVE[1]:.3f}")],
         loc="upper right", fontsize=5.8, handlelength=1.0, borderpad=0.2)
b.axvline(0.5, color=P.INK_FAINT, lw=0.6, ls=":")
b.set_yticks(ys); b.set_yticklabels(names, fontsize=6.3)
b.set_xlim(0.45, 1.2); b.set_xticks([0.5, 0.75, 1.0])
b.set_xlabel("5-fold CV AUC, two-step benign arm")
b.set_title("(b) what a feature block can separate")
b.grid(axis="y", visible=False)

for ext in ("pdf", "png"):
    p = OUT.with_suffix("." + ext)
    p.unlink(missing_ok=True)
    fig.savefig(p, dpi=200 if ext == "png" else None)
    print("  ", p)
