"""Join detector predictions with benchmark ground truth.

Every downstream analysis needs the same table:

    record_id | label | source | distribution | <detector>_score | <detector>_decision

Predictions live in results/<run>/predictions.jsonl keyed by record_id;
ground truth lives in benchmark/data/aegis-bench.jsonl. This module is
the single place that joins them, so a schema change breaks in one file
rather than four.

Score normalisation is the subtle part. Detectors expose wildly
different score surfaces:

    aegis_rules        4 distinct values, null for 98% of calls
    keyword_blacklist  binary {0, 1}
    llama_guard        binary {0, 1}
    llm_judge_*        6-13 distinct values in [0, 1]

A null risk_score is NOT missing data — it means the detector had
nothing to say, which for a rules engine is an implicit "benign".
We map null -> 0.0 and record the null rate separately, because the
null rate is itself a finding (a detector that abstains on 98% of
inputs by returning null is not a calibrated scorer).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

ROOT = Path(__file__).resolve().parents[1]
BENCH = ROOT / "benchmark" / "data" / "aegis-bench.jsonl"
RESULTS = ROOT / "results"

# The five detector families that have full 5,525-record coverage on the
# unshifted benchmark. Cascade runs are excluded here because they were
# evaluated on a held-out split (n=2,763) and so are not comparable
# row-for-row with the single-layer detectors.
FULL_BENCH_RUNS: dict[str, str] = {
    "no_defense":          "no_defense__aegis-bench__20260415-224314",
    "keyword_blacklist":   "keyword_blacklist__aegis-bench__20260415-224314",
    "aegis_rules":         "aegis_rules__aegis-bench__20260416-173938",
    "llama_guard":         "llama_guard__aegis-bench__20260417-102343",
    "llm_judge_anthropic": "llm_judge_anthropic__aegis-bench__20260416-171722",
    "llm_judge_openai":    "llm_judge_openai__aegis-bench__20260417-041945",
}

# Detector family taxonomy — used to group results and to argue about
# whether failure modes are correlated *within* a family.
FAMILY: dict[str, str] = {
    "no_defense":          "none",
    "keyword_blacklist":   "lexical",
    "aegis_rules":         "lexical",
    "llama_guard":         "learned-classifier",
    "llm_judge_anthropic": "llm-judge",
    "llm_judge_openai":    "llm-judge",
}

DISPLAY: dict[str, str] = {
    "no_defense":          "No defense",
    "keyword_blacklist":   "Keyword blacklist",
    "aegis_rules":         "AEGIS rules (L1)",
    "llama_guard":         "Llama-Guard-3-8B",
    "llm_judge_anthropic": "LLM judge (Haiku 4.5)",
    "llm_judge_openai":    "LLM judge (GPT-4o-mini)",
}


@dataclass
class Record:
    """One benchmark item with every detector's verdict attached."""

    record_id: str
    label: str                       # "malicious" | "benign"
    source: str                      # injecagent | toolemu | aegis_self | owasp
    distribution: str                # in_distribution | near_ood | far_ood
    category: str
    scores: dict[str, float] = field(default_factory=dict)
    decisions: dict[str, str] = field(default_factory=dict)
    score_was_null: dict[str, bool] = field(default_factory=dict)

    @property
    def is_malicious(self) -> bool:
        return self.label == "malicious"

    def blocked_by(self, detector: str) -> bool:
        return self.decisions.get(detector) == "block"


def _iter_bench() -> Iterator[dict]:
    with BENCH.open() as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def load(runs: dict[str, str] | None = None) -> list[Record]:
    """Load the joined table. Records missing from any run are dropped.

    Dropping is safe here because all five runs cover the identical
    5,525 ids; the guard exists so a partial re-run can't silently
    produce a table where different detectors are scored on different
    subsets (which would make every comparison meaningless).
    """
    runs = runs or FULL_BENCH_RUNS

    records: dict[str, Record] = {}
    for row in _iter_bench():
        records[row["id"]] = Record(
            record_id=row["id"],
            label=row["label"],
            source=row["source"],
            distribution=row.get("distribution", "unknown"),
            category=row.get("category", "uncategorized"),
        )

    for detector, run_dir in runs.items():
        path = RESULTS / run_dir / "predictions.jsonl"
        if not path.exists():
            raise FileNotFoundError(f"missing predictions for {detector}: {path}")
        seen = 0
        with path.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                pred = json.loads(line)
                rec = records.get(pred["record_id"])
                if rec is None:
                    continue
                raw = pred.get("risk_score")
                rec.score_was_null[detector] = raw is None
                # null == "the detector had nothing to say" == implicit benign.
                rec.scores[detector] = 0.0 if raw is None else float(raw)
                rec.decisions[detector] = pred.get("decision", "allow")
                seen += 1
        if seen == 0:
            raise ValueError(f"{detector}: joined zero records — id scheme mismatch?")

    complete = [
        r for r in records.values()
        if all(d in r.decisions for d in runs)
    ]
    return complete


def summarize(records: list[Record], runs: dict[str, str] | None = None) -> None:
    """Print a load report — sanity gate before any analysis runs."""
    runs = runs or FULL_BENCH_RUNS
    n = len(records)
    mal = sum(1 for r in records if r.is_malicious)
    print(f"joined records: {n}  (malicious {mal}, benign {n - mal})")

    by_dist: dict[str, list[Record]] = {}
    for r in records:
        by_dist.setdefault(r.distribution, []).append(r)
    print("\nby distribution partition:")
    for dist, rs in sorted(by_dist.items()):
        m = sum(1 for r in rs if r.is_malicious)
        print(f"  {dist:18s} n={len(rs):5d}  malicious={m:5d}  benign={len(rs) - m:5d}")

    by_src: dict[str, list[Record]] = {}
    for r in records:
        by_src.setdefault(r.source, []).append(r)
    print("\nby source:")
    for src, rs in sorted(by_src.items()):
        m = sum(1 for r in rs if r.is_malicious)
        print(f"  {src:18s} n={len(rs):5d}  malicious={m:5d}  benign={len(rs) - m:5d}")

    print("\nscore surface per detector (the calibration problem):")
    for d in runs:
        vals = sorted({round(r.scores[d], 3) for r in records})
        nulls = sum(1 for r in records if r.score_was_null.get(d))
        print(f"  {DISPLAY[d]:24s} distinct={len(vals):3d}  null_rate={nulls / n:6.1%}  values={vals[:8]}")


if __name__ == "__main__":
    recs = load()
    summarize(recs)
