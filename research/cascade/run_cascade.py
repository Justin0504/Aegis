"""Run the cascade on the benchmark with configurable per-layer toggles.

Examples:
    # Full cascade with IForest L2 (unsupervised, default)
    python -m cascade.run_cascade --l1 aegis_rules --l3 llm_judge_anthropic \
        --l3-model claude-haiku-4-5-20251001

    # Full cascade with XGBoost L2 (supervised)
    python -m cascade.run_cascade --l1 aegis_rules --l2-mode xgboost \
        --l3 llm_judge_anthropic --l3-model claude-haiku-4-5-20251001

    # XGBoost L2 only (no L3 — test how good supervised L2 is alone)
    python -m cascade.run_cascade --l1 aegis_rules --l2-mode xgboost --no-l3
"""

from __future__ import annotations

import argparse
import json
import random
import time
from datetime import datetime
from pathlib import Path

from tqdm import tqdm

from baselines import all_baselines, get_baseline
from baselines.metrics import compute_summary
from benchmark.schema import BenchRecord, Label
from cascade.pipeline import CascadePipeline, CascadeThresholds

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BENCH = ROOT / "benchmark" / "data" / "aegis-bench.jsonl"
RESULTS_ROOT = ROOT / "results"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--bench", type=Path, default=DEFAULT_BENCH)
    p.add_argument("--l1", choices=all_baselines(), default="aegis_rules")
    p.add_argument("--l3", choices=all_baselines(), default=None,
                   help="If unset, L3 disabled even with --l3 flag absent")
    p.add_argument("--l3-model", default=None)
    p.add_argument("--no-l1", dest="use_l1", action="store_false")
    p.add_argument("--no-l2", dest="use_l2", action="store_false")
    p.add_argument("--no-l3", dest="use_l3", action="store_false")
    p.add_argument("--l2-mode", choices=["iforest", "xgboost"], default="iforest",
                   help="L2 backend: unsupervised IForest or supervised XGBoost")
    p.add_argument("--tau-high", type=float, default=0.7)
    p.add_argument("--tau-low", type=float, default=0.4)
    p.add_argument("--l2-fit-frac", type=float, default=0.5,
                   help="Fraction of records used to fit L2 (rest for test)")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--no-l2-block", dest="disable_l2_block", action="store_true",
                   help="L2 only triages (never auto-blocks); eliminates L2 FP")
    p.add_argument("--xgb-target-fpr", type=float, default=0.01,
                   help="XGBoost: target FP rate for tau_low calibration")
    p.add_argument("--xgb-target-fnr", type=float, default=0.05,
                   help="XGBoost: target FN rate for tau_high calibration")
    p.add_argument("--tag", default="cascade")
    args = p.parse_args()

    records = [BenchRecord.model_validate_json(l) for l in args.bench.open()]
    if args.limit:
        records = records[: args.limit]

    rng = random.Random(args.seed)

    # ── Data split ──────────────────────────────────────────────────────────
    if args.l2_mode == "xgboost":
        # Supervised: need both malicious and benign for training.
        # Stratified split: fit_frac for training, rest for evaluation.
        benign = [r for r in records if r.label == Label.BENIGN]
        malicious = [r for r in records if r.label == Label.MALICIOUS]
        rng.shuffle(benign)
        rng.shuffle(malicious)
        fit_n_benign = int(len(benign) * args.l2_fit_frac)
        fit_n_mal = int(len(malicious) * args.l2_fit_frac)
        fit_set = benign[:fit_n_benign] + malicious[:fit_n_mal]
        fit_ids = {r.id for r in fit_set}
        test_set = [r for r in records if r.id not in fit_ids]
    else:
        # Unsupervised (IForest): only benign for training.
        benign = [r for r in records if r.label == Label.BENIGN]
        rng.shuffle(benign)
        fit_n = int(len(benign) * args.l2_fit_frac)
        fit_set = benign[:fit_n]
        fit_ids = {r.id for r in fit_set}
        test_set = [r for r in records if r.id not in fit_ids]

    l1 = get_baseline(args.l1) if args.use_l1 else None
    l3_kwargs = {"model": args.l3_model} if args.l3_model else {}
    l3 = get_baseline(args.l3, **l3_kwargs) if (args.use_l3 and args.l3) else None

    cascade = CascadePipeline(
        l1=l1, l3=l3,
        thresholds=CascadeThresholds(tau_high=args.tau_high, tau_low=args.tau_low,
                                     disable_l2_block=args.disable_l2_block),
        use_l1=args.use_l1, use_l2=args.use_l2, use_l3=args.use_l3 and bool(args.l3),
        l2_mode=args.l2_mode,
        random_state=args.seed,
    )
    cascade.warmup()

    # ── Fit L2 ──────────────────────────────────────────────────────────────
    if args.use_l2:
        if args.l2_mode == "xgboost":
            if not fit_set:
                print("WARNING: no records available to fit XGBoost L2; skipping.")
                cascade.use_l2 = False
            else:
                print(f"Fitting XGBoost L2 on {len(fit_set)} labeled records "
                      f"({sum(1 for r in fit_set if r.label == Label.MALICIOUS)} mal, "
                      f"{sum(1 for r in fit_set if r.label == Label.BENIGN)} ben) ...")
                stats = cascade.fit_l2_supervised(
                    fit_set,
                    target_fpr=args.xgb_target_fpr,
                    target_fnr=args.xgb_target_fnr,
                )
                print(f"  Calibrated thresholds: tau_high={cascade.thresholds.tau_high:.4f}, "
                      f"tau_low={cascade.thresholds.tau_low:.4f}")
                print(f"  Training stats: {json.dumps(stats, indent=2)}")
        else:
            benign_fit = [r for r in fit_set if r.label == Label.BENIGN] if args.l2_mode == "iforest" else fit_set
            if not benign_fit:
                print("WARNING: no benign records available to fit L2; skipping.")
                cascade.use_l2 = False
            else:
                print(f"Fitting L2 IForest on {len(benign_fit)} benign records ...")
                cascade.fit_l2(benign_fit)

    ts = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    l2_tag = args.l2_mode if args.use_l2 else "none"
    flags = f"l1{int(args.use_l1)}_l2{l2_tag}_l3{int(args.use_l3 and bool(args.l3))}"
    out_dir = RESULTS_ROOT / f"{args.tag}__{flags}__{ts}"
    out_dir.mkdir(parents=True, exist_ok=True)
    pred_path = out_dir / "predictions.jsonl"

    t_start = time.perf_counter()
    with pred_path.open("w") as f:
        for rec in tqdm(test_set, desc="cascade"):
            f.write(cascade.predict(rec).model_dump_json() + "\n")
    elapsed = time.perf_counter() - t_start

    summary = compute_summary(test_set, pred_path)
    summary.update({
        "method": "cascade",
        "use_l1": args.use_l1, "use_l2": args.use_l2,
        "use_l3": args.use_l3 and bool(args.l3),
        "l2_mode": args.l2_mode,
        "l1_baseline": args.l1 if args.use_l1 else None,
        "l3_baseline": args.l3 if (args.use_l3 and args.l3) else None,
        "l3_model": args.l3_model,
        "thresholds": {
            "tau_high": cascade.thresholds.tau_high,
            "tau_low": cascade.thresholds.tau_low,
        },
        "l2_fit_n": len(fit_set),
        "n_test": len(test_set),
        "wall_time_s": round(elapsed, 3),
        "timestamp": ts,
    })
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    cascade.shutdown()

    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
