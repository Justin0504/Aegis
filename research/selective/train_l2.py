"""Train the L2 behavioural classifier and emit CONTINUOUS scores.

Why this exists. Tier-1 found that every detector already evaluated
exposes a score surface of 2-13 distinct values, and showed that such a
surface cannot be risk-controlled: the conformal quantile is a step
function, so moving the target alpha from 5% to 3% leaves the threshold
on the same plateau and nothing happens. Adaptive control has no
traction on a detector that can only say "yes" or "no".

L2 is the one deployed AEGIS layer that emits a real probability.
Training it here gives the streaming experiment a detector whose
threshold can actually move, without needing a GPU or an API budget.

Protocol, chosen so the shift experiment stays honest:

    train   phase-A only (InjecAgent / data_exfiltration + benign)
    score   the entire benchmark
    shift   phase-B (InjecAgent / unauthorized_action) is never seen
            during training, so its degradation is genuine

Output is written as a standard predictions.jsonl so the existing
loader, conformal, and adaptive code consume it unchanged.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import numpy as np
from xgboost import XGBClassifier

from benchmark.schema import BenchRecord
from cascade.features import encode

ROOT = Path(__file__).resolve().parents[1]
BENCH = ROOT / "benchmark" / "data" / "aegis-bench.jsonl"
RESULTS = ROOT / "results"
RUN_NAME = "l2_xgboost__aegis-bench__selective"


def load_bench() -> list[BenchRecord]:
    out = []
    with BENCH.open() as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(BenchRecord.model_validate_json(line))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train-category", default="data_exfiltration")
    ap.add_argument("--source", default="injecagent")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--n-estimators", type=int, default=300)
    ap.add_argument("--max-depth", type=int, default=6)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    records = load_bench()
    print(f"loaded {len(records)} benchmark records")

    # Feature-encode once; reused for train and score.
    X_all = np.vstack([encode(r.tool_call).vector for r in records])
    y_all = np.array([1 if r.label == "malicious" else 0 for r in records])
    print(f"encoded features: {X_all.shape}")

    # Training pool: phase-A malicious + benign from the same source.
    # Phase-B malicious (unauthorized_action) is deliberately excluded so
    # the shift measured downstream is a true generalisation gap.
    train_idx = [
        i for i, r in enumerate(records)
        if r.source == args.source and (
            (r.label == "malicious" and r.category == args.train_category)
            or r.label == "benign"
        )
    ]
    rng.shuffle(train_idx)
    # Hold out a slice so we can report honest in-distribution AUC rather
    # than a training-set number.
    n_val = max(200, int(len(train_idx) * 0.2))
    val_idx, fit_idx = train_idx[:n_val], train_idx[n_val:]

    Xf, yf = X_all[fit_idx], y_all[fit_idx]
    Xv, yv = X_all[val_idx], y_all[val_idx]
    pos = int(yf.sum())
    neg = len(yf) - pos
    print(f"train n={len(fit_idx)} (mal {pos} / ben {neg})   val n={len(val_idx)}")

    model = XGBClassifier(
        n_estimators=args.n_estimators,
        max_depth=args.max_depth,
        learning_rate=0.1,
        subsample=0.9,
        colsample_bytree=0.9,
        # Class weight keeps the model from collapsing to the majority
        # class; the benchmark is roughly 60/40 malicious/benign overall
        # but the phase-A training slice is not.
        scale_pos_weight=(neg / pos) if pos else 1.0,
        eval_metric="logloss",
        tree_method="hist",
        random_state=args.seed,
    )
    model.fit(Xf, yf)

    # in-distribution validation AUC
    from sklearn.metrics import roc_auc_score
    pv = model.predict_proba(Xv)[:, 1]
    print(f"held-out in-distribution AUC: {roc_auc_score(yv, pv):.4f}")

    # Score everything.
    probs = model.predict_proba(X_all)[:, 1]
    print(f"score surface: {len(set(np.round(probs, 6)))} distinct values "
          f"in [{probs.min():.4f}, {probs.max():.4f}]")

    out_dir = RESULTS / RUN_NAME
    out_dir.mkdir(parents=True, exist_ok=True)
    pred_path = out_dir / "predictions.jsonl"
    # Decision threshold is nominal here — every downstream consumer in
    # this package thresholds the score itself. 0.5 is recorded only so
    # the file matches the shared prediction schema.
    with pred_path.open("w") as f:
        for r, p in zip(records, probs):
            f.write(json.dumps({
                "record_id": r.id,
                "decision": "block" if p >= 0.5 else "allow",
                "risk_score": float(p),
                "latency_ms": 0.8,
                "cost_usd": 0.0,
                "layer_fired": "L2",
                "rationale": "xgboost behavioural classifier",
                "raw": {"model": "xgboost", "trained_on": args.train_category},
            }) + "\n")

    meta = {
        "train_category": args.train_category,
        "source": args.source,
        "n_fit": len(fit_idx),
        "n_val": len(val_idx),
        "val_auc": float(roc_auc_score(yv, pv)),
        "distinct_scores": int(len(set(np.round(probs, 6)))),
        "n_estimators": args.n_estimators,
        "max_depth": args.max_depth,
    }
    (out_dir / "summary.json").write_text(json.dumps(meta, indent=2))
    print(f"wrote {pred_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
