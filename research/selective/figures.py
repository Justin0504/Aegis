"""Publication figures for the selective-safety audit.

    python -m selective.figures

Two figures, each answering one question a reviewer will ask.

  selective_guarantee.pdf
      "Does the risk guarantee survive distribution shift?"
      Nominal alpha on x, realised miss rate on y, y=x is the guarantee
      boundary. Under exchangeability points sit on/below the diagonal;
      under a single-source shift they sit above it, and the vertical
      distance is the size of the broken promise.

  selective_cost.pdf
      "What does the guarantee cost?"
      Abstention rate (fraction of traffic escalated) against alpha,
      separating the benign tax from total abstention — the benign tax
      is what an operator actually feels.
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from .loader import DISPLAY

ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / "results" / "selective" / "audit.json"
FIGS = ROOT / "paper-emnlp" / "figures"

# Only detectors whose score surface can actually trade off; the binary
# ones pin to t=0 (escalate everything) and would plot as a flat line at
# zero miss / 100% abstention, which is true but uninformative.
PLOT = ["llm_judge_openai", "llm_judge_anthropic"]
COLOR = {"llm_judge_openai": "#C0562F", "llm_judge_anthropic": "#2F6E4F"}
MARK = {"llm_judge_openai": "o", "llm_judge_anthropic": "s"}


def _series(rows: list[dict], detector: str, key: str) -> tuple[list, list]:
    sel = [r for r in rows if r["detector"] == detector and r["certifiable"]]
    sel.sort(key=lambda r: r["alpha"])
    return [r["alpha"] for r in sel], [r[key] for r in sel]


def guarantee_figure(audit: dict) -> Path:
    fig, ax = plt.subplots(figsize=(6.2, 4.4))
    ax.set_facecolor("#FAF8F4")

    lim, xlim = 0.30, 0.12
    ax.fill_between([0, xlim], [0, xlim], [lim, lim], color="#C0562F", alpha=0.05, zorder=0)
    ax.plot([0, lim], [0, lim], ls="--", lw=1.2, color="#666", zorder=1)
    ax.annotate("guarantee boundary\n(realised = nominal)", xy=(0.100, 0.100),
                xytext=(0.052, 0.152), fontsize=8, color="#555", style="italic",
                ha="center",
                arrowprops=dict(arrowstyle="->", color="#666", lw=0.9))
    ax.text(0.004, 0.283, "GUARANTEE VIOLATED", fontsize=9,
            color="#C0562F", weight="bold", va="top")
    ax.text(0.075, 0.012, "guarantee held", fontsize=9,
            color="#2F6E4F", weight="bold")

    for d in PLOT:
        xi, yi = _series(audit["conformal"]["iid"], d, "realised_miss_rate")
        xs, ys = _series(audit["conformal"]["shift"], d, "realised_miss_rate")
        ax.plot(xi, yi, marker=MARK[d], ms=7, lw=1.8, color=COLOR[d],
                label=f"{DISPLAY[d]} — exchangeable", zorder=3)
        ax.plot(xs, ys, marker=MARK[d], ms=7, lw=1.8, ls=":", color=COLOR[d],
                mfc="white", mew=1.8, label=f"{DISPLAY[d]} — source shift", zorder=3)

    # Call out the headline violation explicitly.
    worst = audit.get("worst_violation")
    if worst:
        ax.annotate(
            f"promised $\\leq${worst['alpha']:.0%}, delivered {worst['realised_miss_rate']:.1%}\n"
            f"({worst['realised_miss_rate'] / worst['alpha']:.1f}$\\times$ the bound)",
            xy=(worst["alpha"], worst["realised_miss_rate"]),
            xytext=(0.030, 0.078), fontsize=8, color="#8C3D1E",
            arrowprops=dict(arrowstyle="->", color="#8C3D1E", lw=1.0),
        )

    ax.set_xlabel("Nominal risk level  $\\alpha$  (promised max miss rate)", fontsize=10)
    ax.set_ylabel("Realised miss rate on malicious calls", fontsize=10)
    ax.set_xlim(0, xlim)
    ax.set_ylim(0, lim)
    ax.grid(alpha=0.25, ls=":")
    ax.legend(fontsize=7.5, loc="upper center", framealpha=0.96, ncol=1)
    ax.set_title("Conformal risk guarantees do not survive source shift", fontsize=11)

    FIGS.mkdir(parents=True, exist_ok=True)
    out = FIGS / "selective_guarantee.pdf"
    fig.tight_layout()
    fig.savefig(out, bbox_inches="tight", dpi=200)
    fig.savefig(out.with_suffix(".png"), bbox_inches="tight", dpi=200)
    plt.close(fig)
    return out


def cost_figure(audit: dict) -> Path:
    fig, axes = plt.subplots(1, 2, figsize=(9.0, 3.8), sharey=True)
    for ax, regime, title in zip(
        axes, ("iid", "shift"),
        ("Exchangeable split", "Source shift"),
    ):
        ax.set_facecolor("#FAF8F4")
        rows = audit["conformal"][regime]
        for d in PLOT:
            x, y = _series(rows, d, "abstention_rate")
            _, yb = _series(rows, d, "benign_abstention")
            ax.plot(x, y, marker=MARK[d], ms=6, lw=1.8, color=COLOR[d],
                    label=f"{DISPLAY[d]} — all traffic")
            ax.plot(x, yb, marker=MARK[d], ms=6, lw=1.5, ls="--", color=COLOR[d],
                    mfc="white", label=f"{DISPLAY[d]} — benign only")
        ax.set_xlabel("Nominal risk level  $\\alpha$", fontsize=10)
        ax.set_title(title, fontsize=10.5)
        ax.grid(alpha=0.25, ls=":")
        ax.set_ylim(0, 1.02)
    axes[0].set_ylabel("Fraction of traffic escalated", fontsize=10)
    axes[1].legend(fontsize=7.5, loc="lower right", framealpha=0.95)

    out = FIGS / "selective_cost.pdf"
    fig.tight_layout()
    fig.savefig(out, bbox_inches="tight", dpi=200)
    fig.savefig(out.with_suffix(".png"), bbox_inches="tight", dpi=200)
    plt.close(fig)
    return out


def main() -> int:
    audit = json.loads(AUDIT.read_text())
    for p in (guarantee_figure(audit), cost_figure(audit)):
        print(f"wrote {p}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
