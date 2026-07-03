"""Temperature scaling for L3 judge calibration.

Guo et al. (ICML 2017) — a single scalar T learned on validation logits
fixes systematic over/underconfidence without moving accuracy. We use
scalar (Brent) minimization of NLL because the L3 judge returns a
single risk_score in [0, 1] (not multi-class logits), so full Platt/
matrix scaling would be overkill.

Application:
    p_calibrated = sigmoid(logit(p_raw) / T)

    T > 1 → softens overconfident predictions   (typical case for LLM judges)
    T < 1 → sharpens underconfident predictions
    T = 1 → identity (no calibration)

Directly redeems the promise in the marketing blog
(https://aegistraces.com/blog/llm-judge-calibration) that temperature
scaling reduces ECE by ~40 % on the same data.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np


@dataclass
class TemperatureScaler:
    """Single-parameter post-hoc calibrator.

    Persistent state is just `T`; call `fit(probs, labels)` on a held-out
    validation split, then `transform(p)` (vectorised) or
    `calibrate_scalar(p)` (single call) at inference.
    """

    T: float = 1.0

    # ── math ────────────────────────────────────────────────────────────

    @staticmethod
    def _logit(p: np.ndarray, eps: float = 1e-6) -> np.ndarray:
        p = np.clip(p, eps, 1.0 - eps)
        return np.log(p / (1.0 - p))

    @staticmethod
    def _sigmoid(z: np.ndarray) -> np.ndarray:
        # Numerically stable sigmoid.
        out = np.empty_like(z, dtype=np.float64)
        pos = z >= 0
        out[pos] = 1.0 / (1.0 + np.exp(-z[pos]))
        exp_z = np.exp(z[~pos])
        out[~pos] = exp_z / (1.0 + exp_z)
        return out

    # ── fitting ─────────────────────────────────────────────────────────

    def fit(
        self,
        probs: np.ndarray,
        labels: np.ndarray,
        bounds: tuple[float, float] = (0.05, 20.0),
    ) -> dict[str, float]:
        """Minimise validation NLL over a bounded scalar T.

        Args:
            probs:  shape (n,) raw L3 risk_scores in [0, 1].
            labels: shape (n,) ground-truth 0/1 (1 = should_block).
            bounds: (lo, hi) search interval for T.

        Returns:
            {'T': fitted value, 'val_nll': loss at optimum,
             'ece_before': ECE before calibration,
             'ece_after':  ECE after calibration}.
        """
        from scipy.optimize import minimize_scalar

        probs = np.asarray(probs, dtype=np.float64)
        labels = np.asarray(labels, dtype=np.float64)
        if probs.ndim != 1 or probs.shape != labels.shape:
            raise ValueError('probs and labels must be same 1-D shape')
        if len(probs) < 10:
            raise ValueError('need at least 10 validation samples')

        logits = self._logit(probs)

        def nll(T: float) -> float:
            if T <= 0:
                return 1e9
            p = self._sigmoid(logits / T)
            p = np.clip(p, 1e-6, 1.0 - 1e-6)
            return -float(np.mean(
                labels * np.log(p) + (1.0 - labels) * np.log(1.0 - p)
            ))

        res = minimize_scalar(
            nll, bounds=bounds, method='bounded',
            options={'xatol': 1e-4, 'maxiter': 200},
        )
        self.T = float(res.x)

        ece_before = self.ece(probs, labels)
        ece_after = self.ece(self.transform(probs), labels)
        return {
            'T':          self.T,
            'val_nll':    float(res.fun),
            'ece_before': ece_before,
            'ece_after':  ece_after,
            'ece_delta':  ece_before - ece_after,
        }

    # ── application ─────────────────────────────────────────────────────

    def transform(self, probs: np.ndarray) -> np.ndarray:
        """Vectorised calibration."""
        p = np.asarray(probs, dtype=np.float64)
        return self._sigmoid(self._logit(p) / self.T)

    def calibrate_scalar(self, p: float) -> float:
        """Single-value calibration — the hot-path shape for L3."""
        if self.T == 1.0:
            return float(p)
        return float(self._sigmoid(self._logit(np.array([p])) / self.T)[0])

    # ── evaluation ──────────────────────────────────────────────────────

    @staticmethod
    def ece(probs: np.ndarray, labels: np.ndarray, n_bins: int = 10) -> float:
        """Guo et al. 2017 binning-based ECE, same estimator used in
        the AEGIS calibration blog post so the numbers are comparable."""
        probs = np.asarray(probs, dtype=np.float64)
        labels = np.asarray(labels, dtype=np.float64)
        bins = np.linspace(0.0, 1.0, n_bins + 1)
        n = len(probs)
        if n == 0:
            return 0.0
        ece = 0.0
        for lo, hi in zip(bins[:-1], bins[1:]):
            mask = (probs > lo) & (probs <= hi)
            k = int(mask.sum())
            if k == 0:
                continue
            acc  = float(labels[mask].mean())
            conf = float(probs[mask].mean())
            ece += (k / n) * abs(acc - conf)
        return float(ece)

    # ── persistence ─────────────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        return {'T': self.T}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> 'TemperatureScaler':
        return cls(T=float(d.get('T', 1.0)))
