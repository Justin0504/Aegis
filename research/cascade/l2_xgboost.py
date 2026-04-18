"""Supervised L2 classifier using XGBoost.

Replaces the unsupervised Isolation Forest with a gradient-boosted tree
classifier trained on labeled (malicious/benign) tool calls.  Uses the
same 15-dimensional feature vector as IForest so the rest of the cascade
pipeline is unchanged.

The classifier outputs a probability P(malicious) in [0, 1].  The cascade
uses the same threshold semantics:
    score >= tau_high  ->  BLOCK  (confident malicious)
    score <  tau_low   ->  ALLOW  (confident benign)
    else               ->  escalate to L3
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
from xgboost import XGBClassifier

from benchmark.schema import BenchRecord, Label
from cascade.features import encode


@dataclass
class XGBThresholds:
    """Operating thresholds calibrated on a validation split.

    tau_high: P(malicious) above which L2 auto-blocks.
    tau_low:  P(malicious) below which L2 auto-allows.
    Between tau_low and tau_high: escalate to L3.
    """
    tau_high: float = 0.90
    tau_low: float = 0.10


class L2XGBoost:
    """Supervised L2 layer backed by XGBoost."""

    def __init__(
        self,
        n_estimators: int = 300,
        max_depth: int = 6,
        learning_rate: float = 0.1,
        random_state: int = 0,
        scale_pos_weight: float | None = None,
    ):
        self._params = dict(
            n_estimators=n_estimators,
            max_depth=max_depth,
            learning_rate=learning_rate,
            random_state=random_state,
            use_label_encoder=False,
            eval_metric="logloss",
            tree_method="hist",
        )
        if scale_pos_weight is not None:
            self._params["scale_pos_weight"] = scale_pos_weight
        self._model: Optional[XGBClassifier] = None
        self.thresholds = XGBThresholds()
        self._fitted = False

    @property
    def fitted(self) -> bool:
        return self._fitted

    def fit(
        self,
        records: list[BenchRecord],
        val_frac: float = 0.15,
        calibrate: bool = True,
        target_fpr: float = 0.01,
        target_fnr: float = 0.05,
    ) -> dict:
        """Train XGBoost on labeled records with optional threshold calibration.

        Args:
            records: Labeled BenchRecords (both malicious and benign).
            val_frac: Fraction held out for calibration.
            calibrate: If True, set tau_high/tau_low from validation scores.
            target_fpr: Target false-positive rate for tau_low (benign
                        calls scoring above tau_low get escalated, not
                        auto-allowed; a small fraction is acceptable).
            target_fnr: Target false-negative rate for tau_high (malicious
                        calls scoring below tau_high get escalated instead
                        of auto-blocked; we want very few misses).

        Returns:
            dict with training stats (sizes, thresholds, val metrics).
        """
        X = np.vstack([encode(r.tool_call).vector for r in records])
        y = np.array([1 if r.label == Label.MALICIOUS else 0 for r in records])

        # Stratified split for calibration.
        n = len(records)
        n_val = max(50, int(n * val_frac)) if calibrate else 0
        if n_val > 0:
            rng = np.random.RandomState(self._params["random_state"])
            idx = rng.permutation(n)
            val_idx, train_idx = idx[:n_val], idx[n_val:]
            X_train, y_train = X[train_idx], y[train_idx]
            X_val, y_val = X[val_idx], y[val_idx]
        else:
            X_train, y_train = X, y
            X_val, y_val = None, None

        # Compute class weight if not set.
        if "scale_pos_weight" not in self._params or self._params.get("scale_pos_weight") is None:
            n_neg = int((y_train == 0).sum())
            n_pos = int((y_train == 1).sum())
            self._params["scale_pos_weight"] = n_neg / max(1, n_pos)

        self._model = XGBClassifier(**self._params)
        self._model.fit(X_train, y_train)
        self._fitted = True

        stats: dict = {
            "n_train": len(X_train),
            "n_val": len(X_val) if X_val is not None else 0,
            "n_pos_train": int(y_train.sum()),
            "n_neg_train": int((y_train == 0).sum()),
        }

        # Calibrate thresholds on validation set.
        if X_val is not None and calibrate:
            val_probs = self._model.predict_proba(X_val)[:, 1]
            benign_scores = val_probs[y_val == 0]
            mal_scores = val_probs[y_val == 1]

            # tau_low: P(mal) threshold below which we auto-allow.
            # Set so that at most target_fpr of benign calls score above it.
            if len(benign_scores) > 0:
                self.thresholds.tau_low = float(
                    np.quantile(benign_scores, 1.0 - target_fpr)
                )
            # tau_high: P(mal) threshold above which we auto-block.
            # Set so that at most target_fnr of malicious calls score below it.
            if len(mal_scores) > 0:
                self.thresholds.tau_high = float(
                    np.quantile(mal_scores, target_fnr)
                )
            # Ensure tau_low <= tau_high.
            if self.thresholds.tau_low > self.thresholds.tau_high:
                mid = (self.thresholds.tau_low + self.thresholds.tau_high) / 2
                self.thresholds.tau_low = mid
                self.thresholds.tau_high = mid

            stats["tau_high"] = self.thresholds.tau_high
            stats["tau_low"] = self.thresholds.tau_low
            stats["val_benign_mean"] = float(benign_scores.mean()) if len(benign_scores) else None
            stats["val_mal_mean"] = float(mal_scores.mean()) if len(mal_scores) else None

        return stats

    def score(self, record: BenchRecord) -> float:
        """Return P(malicious) for a single record."""
        assert self._model is not None and self._fitted
        x = encode(record.tool_call).vector.reshape(1, -1)
        return float(self._model.predict_proba(x)[0, 1])
