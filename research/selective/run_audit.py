"""Run the full selective-safety audit and persist every number.

    python -m selective.run_audit

Writes:
    results/selective/audit.json     every metric, machine-readable
    results/selective/audit.txt      the console transcript
    paper-emnlp/figures/selective_*  publication figures

Design note: nothing here recomputes detector predictions. The audit is
a pure function of results/<run>/predictions.jsonl plus the benchmark
labels, so it is cheap, deterministic, and re-runnable after any
benchmark rebuild.
"""

from __future__ import annotations

import json
from pathlib import Path

from .loader import DISPLAY, FAMILY, FULL_BENCH_RUNS, Record, load
from . import complement, conformal

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "results" / "selective"
FIGS = ROOT / "paper-emnlp" / "figures"

DETECTORS = ["keyword_blacklist", "aegis_rules", "llama_guard",
             "llm_judge_anthropic", "llm_judge_openai"]
SCORED = ["aegis_rules", "llama_guard", "llm_judge_anthropic", "llm_judge_openai"]


def score_surface(records: list[Record]) -> dict:
    """Per-detector score granularity — why risk control is or isn't possible."""
    n = len(records)
    out = {}
    for d in DETECTORS:
        vals = sorted({round(r.scores[d], 4) for r in records})
        nulls = sum(1 for r in records if r.score_was_null.get(d))
        out[d] = {
            "display": DISPLAY[d],
            "family": FAMILY[d],
            "distinct_values": len(vals),
            "values": vals[:16],
            "null_rate": nulls / n,
            # A detector needs >2 distinct values to trade miss rate
            # against abstention at all; with 2 it can only pick
            # "escalate nothing" or "escalate everything".
            "conformalizable": len(vals) > 2,
        }
    return out


def per_partition(records: list[Record]) -> dict:
    out = {}
    for part in sorted({r.distribution for r in records}):
        sub = [r for r in records if r.distribution == part]
        mal = [r for r in sub if r.is_malicious]
        if not mal:
            continue
        recalls = {d: sum(1 for r in mal if r.blocked_by(d)) / len(mal) for d in DETECTORS}
        universal_miss = [r for r in mal if not any(r.blocked_by(d) for d in DETECTORS)]
        best = max(recalls.values())
        union = 1.0 - len(universal_miss) / len(mal)
        out[part] = {
            "n": len(sub),
            "n_malicious": len(mal),
            "recall": recalls,
            "best_single": best,
            "union_all": union,
            "cascade_gain": union - best,
        }
    return out


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    records = load()

    audit: dict = {
        "n_records": len(records),
        "n_malicious": sum(1 for r in records if r.is_malicious),
        "n_benign": sum(1 for r in records if not r.is_malicious),
        "runs": FULL_BENCH_RUNS,
    }

    print("=" * 92)
    print("SELECTIVE AGENT SAFETY — AUDIT")
    print("=" * 92)
    print(f"records={audit['n_records']}  malicious={audit['n_malicious']}  benign={audit['n_benign']}")

    # 1. score surface
    audit["score_surface"] = score_surface(records)
    print("\nSCORE SURFACE (can this detector participate in risk control?)")
    for d, s in audit["score_surface"].items():
        flag = "yes" if s["conformalizable"] else "NO — binary"
        print(f"  {s['display']:26s} distinct={s['distinct_values']:3d}  "
              f"null={s['null_rate']:6.1%}  conformalizable={flag}")

    # 2. complementarity
    audit["complementarity"] = complement.report(records, DETECTORS, scope="clean benchmark")

    # 3. per-partition cascade gain
    audit["per_partition"] = per_partition(records)
    print("\nPER-PARTITION CASCADE GAIN")
    for part, v in audit["per_partition"].items():
        print(f"  {part:18s} n_mal={v['n_malicious']:5d}  "
              f"best_single={v['best_single']:6.1%}  union={v['union_all']:6.1%}  "
              f"gain={v['cascade_gain']:+.1%}")

    # 4. conformal, both regimes
    audit["conformal"] = conformal.sweep(records, SCORED, alphas=(0.01, 0.05, 0.10))

    # headline: worst guarantee violation under shift
    viol = [c for c in audit["conformal"]["shift"]
            if c["certifiable"] and not c["guarantee_held"]]
    if viol:
        worst = max(viol, key=lambda c: c["realised_miss_rate"] / c["alpha"])
        audit["worst_violation"] = worst
        print(f"\nWORST GUARANTEE VIOLATION UNDER SHIFT")
        print(f"  {DISPLAY[worst['detector']]} promised <= {worst['alpha']:.0%}, "
              f"delivered {worst['realised_miss_rate']:.2%} "
              f"({worst['realised_miss_rate'] / worst['alpha']:.1f}x the bound)")

    (OUT / "audit.json").write_text(json.dumps(audit, indent=2, default=str))
    print(f"\nwrote {OUT / 'audit.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
