"""Head-to-head trainer for L2 encoders.

Compares three L2 layers on the same aegis-bench split so the paper /
blog claim ("sequence encoder beats tabular XGBoost") has a controlled
number behind it:

    A. XGBoost on 15-dim tabular features (current SOTA in the repo)
    B. MiniLM sentence encoder on JSON-serialised current call
       (window = 1 — no context, isolates the "semantic vs tabular"
       axis).
    C. MiniLM sentence encoder with a SYNTHETIC K = 4 rolling window
       (context = 3 same-source records sampled uniformly, current
       call at t = 0). Upper-bound proxy for "does context help".

Reports F1, ROC-AUC, precision-at-95%-recall, and encoder throughput.

Why synthetic windows for C: aegis-bench.jsonl was flattened during
export — every record has session_id = None. Real multi-hop trajectories
would need running ToolEmu/AgentDojo emulators (~$50-100 of API + a
day of engineering). Sampling K-1 same-source records approximates the
"noise floor" a context-aware encoder would still have to beat. If C
doesn't beat B, real trajectories are unlikely to move the needle much;
if C does beat B, real trajectories are worth the investment.

Usage:
    python -m cascade.scripts.train_l2_sequence \
        --bench benchmark/data/aegis-bench.jsonl \
        --encoder sentence-transformers/all-MiniLM-L6-v2 \
        --device cuda:7 --test-frac 0.2 --seed 0
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np


# ── Bench I/O ──────────────────────────────────────────────────────────

def load_bench(path: Path) -> list[dict[str, Any]]:
    """Load newline-delimited JSON bench records. Keeps the raw dict —
    we don't need the Pydantic schema round-trip here."""
    with path.open() as f:
        return [json.loads(l) for l in f]


def stratified_split(
    records: list[dict[str, Any]],
    test_frac: float,
    seed: int,
) -> tuple[list, list]:
    """Stratified train/test split on the malicious label."""
    rng = random.Random(seed)
    mal    = [r for r in records if r.get("label") == "malicious"]
    benign = [r for r in records if r.get("label") != "malicious"]
    rng.shuffle(mal)
    rng.shuffle(benign)
    n_test_m = int(len(mal)    * test_frac)
    n_test_b = int(len(benign) * test_frac)
    test  = mal[:n_test_m] + benign[:n_test_b]
    train = mal[n_test_m:] + benign[n_test_b:]
    rng.shuffle(test); rng.shuffle(train)
    return train, test


# ── XGBoost baseline ───────────────────────────────────────────────────

def _to_toolcall_stub(r: dict) -> Any:
    """Thin adapter so cascade.features.encode() works on dicts.
    encode() reads .arguments only, so a namespace-with-.arguments is
    enough — avoids a full Pydantic import."""
    class _T: pass
    t = _T()
    t.arguments = r.get("tool_call", {}).get("arguments", {}) or {}
    return t


def xgboost_baseline(train, test, seed: int) -> dict[str, Any]:
    from cascade.features import encode
    from xgboost import XGBClassifier

    t0 = time.perf_counter()
    Xtr = np.vstack([encode(_to_toolcall_stub(r)).vector for r in train])
    ytr = np.array([1 if r.get("label") == "malicious" else 0 for r in train])
    Xte = np.vstack([encode(_to_toolcall_stub(r)).vector for r in test])
    yte = np.array([1 if r.get("label") == "malicious" else 0 for r in test])
    encode_ms = (time.perf_counter() - t0) * 1000

    n_neg = int((ytr == 0).sum())
    n_pos = int((ytr == 1).sum())
    clf = XGBClassifier(
        n_estimators=300, max_depth=6, learning_rate=0.1,
        eval_metric="logloss", tree_method="hist",
        random_state=seed,
        scale_pos_weight=(n_neg / max(1, n_pos)),
    )
    t0 = time.perf_counter()
    clf.fit(Xtr, ytr)
    fit_ms = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    probs = clf.predict_proba(Xte)[:, 1]
    pred_ms = (time.perf_counter() - t0) * 1000

    return _metrics(yte, probs, model="XGBoost/15-dim-tabular",
                    encode_ms=encode_ms, fit_ms=fit_ms, pred_ms=pred_ms,
                    n_train=len(train), n_test=len(test))


# ── MiniLM encoders ────────────────────────────────────────────────────

def _serialise_call(r: dict) -> str:
    tc = r.get("tool_call", {}) or {}
    return json.dumps({
        "tool": tc.get("tool_name"),
        "args": tc.get("arguments"),
        "framework": tc.get("framework"),
    }, sort_keys=True, ensure_ascii=False)


def _render_window(records: list[dict], target_idx: int, k: int) -> str:
    """Render a length-`k` window ending at target_idx. Prefixes each
    call with its reverse age tag."""
    lo = max(0, target_idx - k + 1)
    tail = records[lo: target_idx + 1]
    parts = []
    n = len(tail)
    for i, r in enumerate(tail):
        age = n - 1 - i
        parts.append(f"[t-{age}] {_serialise_call(r)}")
    return "\n".join(parts)


def minilm_window(train, test, encoder_name: str, device: str,
                  window: int, seed: int,
                  calibrate: bool = False,
                  val_frac: float = 0.2) -> dict[str, Any]:
    from sentence_transformers import SentenceTransformer
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import f1_score

    model = SentenceTransformer(encoder_name, device=device)

    if window == 1:
        train_texts = [_serialise_call(r) for r in train]
        test_texts  = [_serialise_call(r) for r in test]
    else:
        # Synthetic window: pool records by source; for each target,
        # sample k-1 previous "context" records from the same source
        # uniformly at random. Reproducible via seed.
        rng = random.Random(seed)
        by_src_train: dict[str, list[dict]] = {}
        for r in train:
            by_src_train.setdefault(r.get("source", "?"), []).append(r)

        def _synth(pool_records: list[dict], record: dict) -> str:
            pool = by_src_train.get(record.get("source", "?"), []) or train
            ctx = rng.sample(pool, k=min(window - 1, len(pool)))
            seq = ctx + [record]
            return _render_window(seq, len(seq) - 1, window)

        train_texts = [_synth(train, r) for r in train]
        test_texts  = [_synth(train, r) for r in test]

    ytr = np.array([1 if r.get("label") == "malicious" else 0 for r in train])
    yte = np.array([1 if r.get("label") == "malicious" else 0 for r in test])

    t0 = time.perf_counter()
    Xtr = np.asarray(model.encode(train_texts, batch_size=64,
                                   show_progress_bar=False, convert_to_numpy=True),
                     dtype=np.float32)
    Xte = np.asarray(model.encode(test_texts, batch_size=64,
                                   show_progress_bar=False, convert_to_numpy=True),
                     dtype=np.float32)
    encode_ms = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    if calibrate:
        # Hold out val_frac of train for temp-scaling + threshold sweep.
        rng = np.random.RandomState(seed)
        n_train = len(train)
        n_val = max(50, int(n_train * val_frac))
        val_idx = rng.permutation(n_train)[:n_val]
        train_mask = np.ones(n_train, dtype=bool); train_mask[val_idx] = False
        Xfit, yfit = Xtr[train_mask], ytr[train_mask]
        Xval, yval = Xtr[val_idx],  ytr[val_idx]
    else:
        Xfit, yfit = Xtr, ytr
        Xval, yval = None, None

    clf = LogisticRegression(C=1.0, max_iter=1000, class_weight="balanced",
                              random_state=seed)
    clf.fit(Xfit, yfit)
    fit_ms = (time.perf_counter() - t0) * 1000

    # Fit TemperatureScaler + threshold on val split (only in calibrate mode).
    tau = 0.5
    T_used = 1.0
    if calibrate and Xval is not None and len(yval) > 0 and len(set(yval)) > 1:
        from cascade.temperature_scaling import TemperatureScaler
        val_probs = clf.predict_proba(Xval)[:, 1]
        ts = TemperatureScaler()
        ts.fit(val_probs, yval)
        val_probs_cal = ts.transform(val_probs)
        # Sweep threshold to maximise val F1.
        best_f1, best_tau = -1.0, 0.5
        for cand in np.linspace(0.05, 0.95, 91):
            p = (val_probs_cal >= cand).astype(int)
            f = f1_score(yval, p, zero_division=0)
            if f > best_f1:
                best_f1, best_tau = f, float(cand)
        tau = best_tau
        T_used = ts.T
    else:
        ts = None

    t0 = time.perf_counter()
    raw_probs = clf.predict_proba(Xte)[:, 1]
    if ts is not None:
        probs = ts.transform(raw_probs)
    else:
        probs = raw_probs
    pred_ms = (time.perf_counter() - t0) * 1000

    tag = f"MiniLM/window={window}"
    if calibrate:
        tag += f"+cal(T={T_used:.2f},tau={tau:.2f})"
    return _metrics(yte, probs, model=tag,
                    encode_ms=encode_ms, fit_ms=fit_ms, pred_ms=pred_ms,
                    n_train=len(train), n_test=len(test),
                    threshold=tau)


# ── Metrics ────────────────────────────────────────────────────────────

def _metrics(y: np.ndarray, probs: np.ndarray, model: str,
             encode_ms: float, fit_ms: float, pred_ms: float,
             n_train: int, n_test: int,
             threshold: float = 0.5) -> dict[str, Any]:
    from sklearn.metrics import (
        f1_score, roc_auc_score, precision_recall_curve, average_precision_score
    )
    preds = (probs >= threshold).astype(int)
    f1 = f1_score(y, preds, zero_division=0)
    auc = roc_auc_score(y, probs) if len(set(y)) > 1 else float('nan')
    ap = average_precision_score(y, probs) if len(set(y)) > 1 else float('nan')

    # precision at 95% recall
    precisions, recalls, _ = precision_recall_curve(y, probs)
    mask = recalls >= 0.95
    p_at_95 = float(precisions[mask].max()) if mask.any() else float('nan')

    per_call_ms = pred_ms / max(1, n_test)
    return {
        "model":     model,
        "n_train":   n_train,
        "n_test":    n_test,
        "f1":        f1,
        "auc":       auc,
        "ap":        ap,
        "p@r=0.95":  p_at_95,
        "encode_ms": encode_ms,
        "fit_ms":    fit_ms,
        "pred_ms":   pred_ms,
        "per_call_ms": per_call_ms,
    }


# ── Reporting ──────────────────────────────────────────────────────────

def print_table(rows: list[dict[str, Any]]) -> None:
    cols = ["model", "n_train", "n_test", "f1", "auc", "ap", "p@r=0.95", "per_call_ms"]
    for r in rows:
        r.setdefault("threshold", 0.5)
    widths = {c: max(len(c), max(len(_fmt(r[c])) for r in rows)) for c in cols}
    header = "  ".join(c.ljust(widths[c]) for c in cols)
    print(header); print("-" * len(header))
    for r in rows:
        print("  ".join(_fmt(r[c]).ljust(widths[c]) for c in cols))


def _fmt(v: Any) -> str:
    if isinstance(v, float):
        return f"{v:.4f}" if abs(v) < 1000 else f"{v:.1f}"
    return str(v)


# ── CLI ────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bench", type=Path, required=True)
    ap.add_argument("--encoder", type=str,
                     default="sentence-transformers/all-MiniLM-L6-v2")
    ap.add_argument("--device", type=str, default="cuda:0")
    ap.add_argument("--test-frac", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--limit", type=int, default=0,
                     help="Cap records for smoke test; 0 = no cap")
    ap.add_argument("--skip-xgb", action="store_true")
    ap.add_argument("--skip-k1",  action="store_true")
    ap.add_argument("--skip-k4",  action="store_true")
    ap.add_argument("--test-bench", type=Path, default=None,
                     help="If set, use --bench for train and this file for "
                          "test (cross-source generalization).")
    ap.add_argument("--train-source", type=str, default=None,
                     help="If set, keep only records with this .source in train")
    ap.add_argument("--calibrate", action="store_true",
                     help="Fit TemperatureScaler + threshold sweep on val split")
    args = ap.parse_args()

    records = load_bench(args.bench)
    if args.limit:
        random.Random(args.seed).shuffle(records)
        records = records[: args.limit]

    if args.test_bench is not None:
        # Cross-source mode: whole --bench = train, whole --test-bench = test.
        train = records
        if args.train_source:
            train = [r for r in train if r.get("source") == args.train_source]
        test = load_bench(args.test_bench)
    else:
        train, test = stratified_split(records, args.test_frac, args.seed)
    print(f"loaded {len(records)} records → train {len(train)} test {len(test)}")
    print(f"train malicious: {sum(1 for r in train if r.get('label')=='malicious')}"
          f" / benign: {sum(1 for r in train if r.get('label')!='malicious')}")
    print(f"test  malicious: {sum(1 for r in test if r.get('label')=='malicious')}"
          f" / benign: {sum(1 for r in test if r.get('label')!='malicious')}")
    print()

    rows: list[dict[str, Any]] = []
    if not args.skip_xgb:
        print(">>> A. XGBoost / 15-dim tabular ..."); sys.stdout.flush()
        rows.append(xgboost_baseline(train, test, args.seed))
    if not args.skip_k1:
        print(">>> B. MiniLM / window=1 ..."); sys.stdout.flush()
        rows.append(minilm_window(train, test, args.encoder, args.device, 1,
                                    args.seed, calibrate=args.calibrate))
    if not args.skip_k4:
        print(">>> C. MiniLM / synthetic window=4 ..."); sys.stdout.flush()
        rows.append(minilm_window(train, test, args.encoder, args.device, 4,
                                    args.seed, calibrate=args.calibrate))
    print()
    print_table(rows)

    # Persist JSON alongside the bench file so the paper table has a
    # source-of-truth artifact.
    out = args.bench.with_suffix(".l2seq-results.json")
    with out.open("w") as f:
        json.dump({"args": {k: str(v) for k, v in vars(args).items()},
                    "rows": rows}, f, indent=2)
    print(f"\nresults → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
