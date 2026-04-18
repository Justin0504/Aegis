"""Cross-source generalization experiment.

Train XGBoost L2 on InjecAgent data only, test on all other sources
(ToolEmu, OWASP, AEGIS-self) to demonstrate OOD generalization.

Also tests the reverse: train on non-InjecAgent, test on InjecAgent.
"""

from __future__ import annotations

import json
import random
import time
from datetime import datetime, UTC
from pathlib import Path

from tqdm import tqdm

from baselines import get_baseline
from baselines.metrics import compute_summary
from benchmark.schema import BenchRecord, Label
from cascade.pipeline import CascadePipeline, CascadeThresholds

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BENCH = ROOT / "benchmark" / "data" / "aegis-bench.jsonl"
RESULTS_ROOT = ROOT / "results"


def run_split(
    train_records: list[BenchRecord],
    test_records: list[BenchRecord],
    tag: str,
    use_l1: bool = True,
    use_l3: bool = False,
    l3_name: str | None = None,
    l3_model: str | None = None,
    seed: int = 0,
) -> dict:
    """Train XGBoost on train_records, evaluate on test_records."""

    l1 = get_baseline("aegis_rules") if use_l1 else None
    l3 = None
    if use_l3 and l3_name:
        l3_kwargs = {"model": l3_model} if l3_model else {}
        l3 = get_baseline(l3_name, **l3_kwargs)

    cascade = CascadePipeline(
        l1=l1, l3=l3,
        thresholds=CascadeThresholds(),
        use_l1=use_l1,
        use_l2=True,
        use_l3=use_l3 and l3 is not None,
        l2_mode="xgboost",
        random_state=seed,
    )
    cascade.warmup()

    n_mal = sum(1 for r in train_records if r.label == Label.MALICIOUS)
    n_ben = sum(1 for r in train_records if r.label == Label.BENIGN)
    print(f"\n{'='*60}")
    print(f"[{tag}] Training on {len(train_records)} records ({n_mal} mal, {n_ben} ben)")
    print(f"[{tag}] Testing on {len(test_records)} records")

    stats = cascade.fit_l2_supervised(
        train_records, target_fpr=0.01, target_fnr=0.05
    )
    print(f"  tau_high={cascade.thresholds.tau_high:.4f}, tau_low={cascade.thresholds.tau_low:.4f}")

    ts = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    out_dir = RESULTS_ROOT / f"{tag}__{ts}"
    out_dir.mkdir(parents=True, exist_ok=True)
    pred_path = out_dir / "predictions.jsonl"

    t0 = time.perf_counter()
    with pred_path.open("w") as f:
        for rec in tqdm(test_records, desc=tag):
            f.write(cascade.predict(rec).model_dump_json() + "\n")
    elapsed = time.perf_counter() - t0

    summary = compute_summary(test_records, pred_path)
    summary.update({
        "method": "cross_source",
        "tag": tag,
        "l2_mode": "xgboost",
        "train_n": len(train_records),
        "train_mal": n_mal,
        "train_ben": n_ben,
        "test_n": len(test_records),
        "wall_time_s": round(elapsed, 3),
        "thresholds": {
            "tau_high": cascade.thresholds.tau_high,
            "tau_low": cascade.thresholds.tau_low,
        },
        "timestamp": ts,
    })
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2))
    cascade.shutdown()
    return summary


def main() -> int:
    records = [BenchRecord.model_validate_json(l)
               for l in open(DEFAULT_BENCH)]

    by_source: dict[str, list[BenchRecord]] = {}
    for r in records:
        by_source.setdefault(r.source, []).append(r)

    injecagent = by_source.get("injecagent", [])
    toolemu = by_source.get("toolemu", [])
    owasp = by_source.get("owasp", [])
    aegis_self = by_source.get("aegis_self", [])
    ood_test = toolemu + owasp + aegis_self

    results = []

    # Experiment 1: Train on InjecAgent, test on ToolEmu+OWASP+AEGIS-self
    s1 = run_split(injecagent, ood_test, tag="xsource-train-injecagent-test-ood")
    results.append(s1)
    print(f"\n  >> Block={s1['block_rate']*100:.1f}% FP={s1['fp_rate']*100:.2f}% "
          f"P50={s1['latency_ms']['p50']:.2f}ms")

    # Experiment 2: Train on InjecAgent, test on InjecAgent held-out (50/50 split, for comparison)
    rng = random.Random(42)
    rng.shuffle(injecagent)
    half = len(injecagent) // 2
    s2 = run_split(injecagent[:half], injecagent[half:], tag="xsource-train-inject-test-inject")
    results.append(s2)
    print(f"\n  >> Block={s2['block_rate']*100:.1f}% FP={s2['fp_rate']*100:.2f}% "
          f"P50={s2['latency_ms']['p50']:.2f}ms")

    # Experiment 3: Train on ToolEmu+OWASP+AEGIS-self, test on InjecAgent
    # Note: OOD sources have no benign records, so XGBoost needs at least some.
    # We'll train on OOD (mal only) + a small slice of InjecAgent benign for calibration.
    rng2 = random.Random(0)
    inject_benign = [r for r in injecagent if r.label == Label.BENIGN]
    rng2.shuffle(inject_benign)
    calib_benign = inject_benign[:200]  # small benign calibration set
    inject_test = [r for r in injecagent if r.id not in {r.id for r in calib_benign}]
    train_reverse = ood_test + calib_benign
    s3 = run_split(train_reverse, inject_test, tag="xsource-train-ood-test-injecagent")
    results.append(s3)
    print(f"\n  >> Block={s3['block_rate']*100:.1f}% FP={s3['fp_rate']*100:.2f}% "
          f"P50={s3['latency_ms']['p50']:.2f}ms")

    # Summary
    print(f"\n{'='*60}")
    print("CROSS-SOURCE GENERALIZATION SUMMARY")
    print(f"{'='*60}")
    for r in results:
        print(f"  {r['tag']:45s}  Block={r['block_rate']*100:.1f}%  "
              f"FP={r['fp_rate']*100:.2f}%  P50={r['latency_ms']['p50']:.2f}ms")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
