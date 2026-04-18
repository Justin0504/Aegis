"""Run a baseline over the unified benchmark and write predictions + summary.

Usage:
    python -m baselines.run --baseline keyword_blacklist
    python -m baselines.run --baseline aegis_rules
    python -m baselines.run --baseline llm_judge_anthropic --model claude-haiku-4-5-20251001
    python -m baselines.run --baseline no_defense --in benchmark/data/aegis-bench.jsonl

Outputs (per run):
    results/<baseline>__<bench>__<ts>/predictions.jsonl
    results/<baseline>__<bench>__<ts>/summary.json

`summary.json` is the per-experiment headline that gets aggregated into the
paper tables.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime
from pathlib import Path

from tqdm import tqdm

from baselines import all_baselines, get_baseline
from benchmark.schema import BenchRecord

from .metrics import compute_summary

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BENCH = ROOT / "benchmark" / "data" / "aegis-bench.jsonl"
RESULTS_ROOT = ROOT / "results"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--baseline", required=True, choices=all_baselines())
    p.add_argument("--in", dest="bench", type=Path, default=DEFAULT_BENCH)
    p.add_argument("--limit", type=int, default=None,
                   help="Run on the first N records (debug)")
    p.add_argument("--model", default=None,
                   help="Forwarded to llm_judge_* baselines")
    p.add_argument("--out", type=Path, default=None)
    args = p.parse_args()

    kwargs = {}
    if args.model and args.baseline.startswith("llm_judge"):
        kwargs["model"] = args.model

    baseline = get_baseline(args.baseline, **kwargs)
    baseline.warmup()

    bench_name = args.bench.stem
    ts = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    out_dir = args.out or (RESULTS_ROOT / f"{args.baseline}__{bench_name}__{ts}")
    out_dir.mkdir(parents=True, exist_ok=True)

    pred_path = out_dir / "predictions.jsonl"
    records: list[BenchRecord] = []
    with args.bench.open() as f:
        for raw in f:
            records.append(BenchRecord.model_validate_json(raw))
    if args.limit:
        records = records[: args.limit]

    t_start = time.perf_counter()
    with pred_path.open("w") as out:
        for rec in tqdm(records, desc=args.baseline):
            try:
                pred = baseline.predict(rec)
            except Exception as e:
                # Robust to a single record blowing up the run.
                from benchmark.schema import Decision, Prediction
                pred = Prediction(
                    record_id=rec.id,
                    decision=Decision.ALLOW,
                    rationale=f"baseline_error::{type(e).__name__}::{e}",
                )
            out.write(pred.model_dump_json() + "\n")
    elapsed = time.perf_counter() - t_start

    summary = compute_summary(records, pred_path)
    summary["baseline"] = args.baseline
    summary["benchmark"] = bench_name
    summary["n_records"] = len(records)
    summary["wall_time_s"] = round(elapsed, 3)
    summary["timestamp"] = ts
    if args.model:
        summary["model"] = args.model

    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    baseline.shutdown()

    print(json.dumps(summary, indent=2))
    print(f"\nPredictions: {pred_path}")
    print(f"Summary    : {out_dir / 'summary.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
