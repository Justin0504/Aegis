"""Cascade pipeline = L1 (rules) -> L2 (behavior model) -> L3 (LLM judge).

L2 supports two modes:
    - Unsupervised: Isolation Forest fitted on benign calls only.
    - Supervised: XGBoost classifier trained on labeled (malicious+benign) calls.

Each layer is independently testable. The pipeline supports per-layer
ablation toggles so the paper's ablation table is just multiple runs.

Decision rule:
    L1.block            -> BLOCK (cheap & confident)
    L2.score > tau_high -> BLOCK (unless disable_l2_block)
    L2.score > tau_low  -> escalate to L3 (if enabled), else ALLOW
    else                -> ALLOW
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Literal, Optional

import numpy as np

from baselines.base import Baseline
from benchmark.schema import BenchRecord, Decision, Prediction

from .features import encode

try:
    from sklearn.ensemble import IsolationForest
except ImportError:  # pragma: no cover
    IsolationForest = None  # type: ignore

try:
    from .l2_xgboost import L2XGBoost
except ImportError:  # pragma: no cover
    L2XGBoost = None  # type: ignore


@dataclass
class CascadeThresholds:
    """Threshold semantics for L2 scoring.

    For IForest: score = -if.score_samples(x), higher = more anomalous.
    For XGBoost: score = P(malicious), higher = more likely malicious.

    tau_high: score above which L2 auto-blocks (unless disable_l2_block).
    tau_low:  score below which L2 auto-allows.
    Between: escalate to L3.
    """
    tau_high: float = 0.7
    tau_low: float = 0.4
    target_fpr_high: float = 0.001  # IForest calibration only
    target_fpr_low: float = 0.80    # IForest calibration only
    disable_l2_block: bool = False


class CascadePipeline(Baseline):
    """A meta-baseline that wraps L1/L2/L3 sub-baselines."""

    baseline_name = "cascade"

    def __init__(
        self,
        l1: Optional[Baseline] = None,
        l3: Optional[Baseline] = None,
        thresholds: CascadeThresholds | None = None,
        use_l1: bool = True,
        use_l2: bool = True,
        use_l3: bool = True,
        l2_mode: Literal["iforest", "xgboost"] = "iforest",
        if_n_estimators: int = 200,
        if_contamination: float = 0.05,
        xgb_n_estimators: int = 300,
        xgb_max_depth: int = 6,
        xgb_learning_rate: float = 0.1,
        random_state: int = 0,
    ):
        self.l1 = l1
        self.l3 = l3
        self.thresholds = thresholds or CascadeThresholds()
        self.use_l1 = use_l1
        self.use_l2 = use_l2
        self.use_l3 = use_l3
        self.l2_mode = l2_mode
        self._if = None
        self._xgb = None
        self._fitted = False

        if use_l2:
            if l2_mode == "iforest":
                if IsolationForest is None:
                    raise RuntimeError("scikit-learn required for IForest L2")
                self._if = IsolationForest(
                    n_estimators=if_n_estimators,
                    contamination=if_contamination,
                    random_state=random_state,
                )
            elif l2_mode == "xgboost":
                if L2XGBoost is None:
                    raise RuntimeError("xgboost required for XGBoost L2")
                self._xgb = L2XGBoost(
                    n_estimators=xgb_n_estimators,
                    max_depth=xgb_max_depth,
                    learning_rate=xgb_learning_rate,
                    random_state=random_state,
                )

    # ── L2 fitting ──────────────────────────────────────────────────────────

    def fit_l2(self, benign_records: list[BenchRecord],
               calibrate: bool = True, val_frac: float = 0.2) -> None:
        """Fit IForest L2 on benign-only records (unsupervised mode)."""
        if not self.use_l2 or self.l2_mode != "iforest":
            return
        assert self._if is not None
        X = np.vstack([encode(r.tool_call).vector for r in benign_records])
        if calibrate and len(X) >= 50:
            n_val = max(20, int(len(X) * val_frac))
            X_train, X_val = X[:-n_val], X[-n_val:]
        else:
            X_train, X_val = X, None
        self._if.fit(X_train)
        self._fitted = True
        if X_val is not None:
            val_scores = -self._if.score_samples(X_val)
            self.thresholds.tau_high = float(np.quantile(
                val_scores, 1.0 - self.thresholds.target_fpr_high))
            self.thresholds.tau_low = float(np.quantile(
                val_scores, 1.0 - self.thresholds.target_fpr_low))

    def fit_l2_supervised(self, records: list[BenchRecord],
                          val_frac: float = 0.15,
                          target_fpr: float = 0.01,
                          target_fnr: float = 0.05) -> dict:
        """Fit XGBoost L2 on labeled records (supervised mode)."""
        if not self.use_l2 or self.l2_mode != "xgboost":
            return {}
        assert self._xgb is not None
        stats = self._xgb.fit(
            records,
            val_frac=val_frac,
            calibrate=True,
            target_fpr=target_fpr,
            target_fnr=target_fnr,
        )
        self.thresholds.tau_high = self._xgb.thresholds.tau_high
        self.thresholds.tau_low = self._xgb.thresholds.tau_low
        self._fitted = True
        return stats

    def warmup(self) -> None:
        if self.use_l1 and self.l1 is not None:
            self.l1.warmup()
        if self.use_l3 and self.l3 is not None:
            self.l3.warmup()

    def shutdown(self) -> None:
        if self.use_l1 and self.l1 is not None:
            self.l1.shutdown()
        if self.use_l3 and self.l3 is not None:
            self.l3.shutdown()

    # ── L2 scoring ──────────────────────────────────────────────────────────

    def _score_l2(self, record: BenchRecord) -> float | None:
        """Return L2 anomaly/risk score, regardless of backend."""
        if self.l2_mode == "xgboost" and self._xgb is not None and self._xgb.fitted:
            return self._xgb.score(record)
        elif self.l2_mode == "iforest" and self._if is not None and self._fitted:
            x = encode(record.tool_call).vector.reshape(1, -1)
            return float(-self._if.score_samples(x)[0])
        return None

    # ── prediction ──────────────────────────────────────────────────────────

    def predict(self, record: BenchRecord) -> Prediction:
        t0 = time.perf_counter()
        layer_fired = "none"
        rationale_parts: list[str] = []
        cost = 0.0

        # L1 — rules.
        if self.use_l1 and self.l1 is not None:
            p1 = self.l1.predict(record)
            cost += p1.cost_usd or 0.0
            rationale_parts.append(f"L1={p1.decision.value}:{p1.rationale or ''}")
            if p1.decision in (Decision.BLOCK, Decision.PENDING):
                return Prediction(
                    record_id=record.id,
                    decision=p1.decision,
                    risk_score=p1.risk_score or 1.0,
                    latency_ms=(time.perf_counter() - t0) * 1000,
                    cost_usd=cost,
                    layer_fired="L1",
                    rationale=" | ".join(rationale_parts),
                )

        # L2 — behavioral scoring (IForest or XGBoost).
        l2_score = self._score_l2(record) if self.use_l2 else None
        if l2_score is not None:
            rationale_parts.append(f"L2={l2_score:.3f}")

            if not self.thresholds.disable_l2_block and l2_score >= self.thresholds.tau_high:
                return Prediction(
                    record_id=record.id,
                    decision=Decision.BLOCK,
                    risk_score=l2_score,
                    latency_ms=(time.perf_counter() - t0) * 1000,
                    cost_usd=cost,
                    layer_fired="L2",
                    rationale=" | ".join(rationale_parts),
                )
            if l2_score < self.thresholds.tau_low:
                return Prediction(
                    record_id=record.id,
                    decision=Decision.ALLOW,
                    risk_score=l2_score,
                    latency_ms=(time.perf_counter() - t0) * 1000,
                    cost_usd=cost,
                    layer_fired="L2",
                    rationale=" | ".join(rationale_parts),
                )
            # else: ambiguous -> escalate to L3

        # L3 — LLM judge.
        if self.use_l3 and self.l3 is not None:
            p3 = self.l3.predict(record)
            cost += p3.cost_usd or 0.0
            rationale_parts.append(f"L3={p3.decision.value}:{(p3.rationale or '')[:80]}")
            return Prediction(
                record_id=record.id,
                decision=p3.decision,
                risk_score=p3.risk_score or l2_score or 0.0,
                latency_ms=(time.perf_counter() - t0) * 1000,
                cost_usd=cost,
                layer_fired="L3",
                rationale=" | ".join(rationale_parts),
            )

        # Default: allow if no layer voted block.
        return Prediction(
            record_id=record.id,
            decision=Decision.ALLOW,
            risk_score=l2_score or 0.0,
            latency_ms=(time.perf_counter() - t0) * 1000,
            cost_usd=cost,
            layer_fired=layer_fired,
            rationale=" | ".join(rationale_parts) or "no_layer_voted",
        )
