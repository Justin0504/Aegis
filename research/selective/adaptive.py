"""AEGIS-SC — a guard that repairs its own risk guarantee under shift.

Tier-1 established the problem: split-conformal calibration promises a
miss rate <= alpha, holds under exchangeability (12/12 cells), and
breaks by up to 9.6x the moment traffic comes from a different source.
A deployed guard has no way to notice this, because noticing requires
labels it does not have.

This module builds the capability. Three pieces, each solving one
concrete obstacle.

1. RANDOM AUDIT — the label problem.
   In deployment you learn nothing about calls you allowed: a missed
   attack is invisible by definition. Escalated calls get labelled (a
   human or a stronger model adjudicates them) but they are exactly the
   high-score calls, so that feedback is biased away from the failure
   mode you care about. We therefore escalate a fraction rho of traffic
   *uniformly at random*, independent of score. Those audits are an
   unbiased sample of what the guard is actually doing, including the
   calls it would have waved through. rho is the price of the
   guarantee, and it is small (2% in our runs).

2. ADAPTIVE CONFORMAL INFERENCE — the shift problem.
   Gibbs & Candes (NeurIPS 2021, arXiv:2106.00170) show that treating
   the working significance level as a control variable and updating it
   by feedback,

       alpha_{t+1} = alpha_t + gamma * (alpha_target - err_t)

   drives the long-run empirical error rate to alpha_target *for any
   data-generating process*, with no exchangeability assumption. We
   apply it to the guard's allow-threshold: err_t is 1 when an audited
   malicious call had been (or would have been) allowed. The result is
   a miss-rate guarantee that survives arbitrary shift, which static
   conformal provably cannot.

   We update only on audited steps, so the effective learning rate is
   gamma per audit rather than per call; gamma is scaled accordingly.

3. CONFORMAL TEST MARTINGALE — the alarm.
   ACI silently repairs the threshold, which is good for safety and bad
   for operators: the guard quietly starts escalating 3x more traffic
   and nobody knows why. Under exchangeability conformal p-values are
   uniform on [0,1], so any betting martingale on them stays bounded in
   expectation; growth is evidence against exchangeability. We run
   Vovk's simple mixture martingale and surface log10(S_t) as a shift
   score. It is an anytime-valid test: thresholding at S_t > 100 gives
   a false-alarm probability <= 1/100 by Ville's inequality, with no
   multiple-testing correction needed however long the stream runs.

Together: the guard keeps its promise under shift (2), pays a known
audit cost to do so (1), and tells the operator that the world moved (3).
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

from .loader import Record


# ─────────────────────────────────────────────────────────────────────
# 3. Conformal test martingale
# ─────────────────────────────────────────────────────────────────────

class ConformalMartingale:
    """Vovk's simple mixture martingale over conformal p-values.

    Under exchangeability p_t ~ Uniform[0,1], and the betting function
    b_eps(p) = eps * p^(eps-1) integrates to 1 for every eps in (0,1).
    Mixing over eps gives a martingale whose growth is evidence against
    exchangeability. Ville's inequality: P(sup_t S_t >= c) <= 1/c.

    We track log10 to avoid overflow on long streams.
    """

    def __init__(self, n_eps: int = 11) -> None:
        # Grid over eps in (0,1), excluding the endpoints where the
        # betting function degenerates.
        self.eps = [(i + 1) / (n_eps + 1) for i in range(n_eps)]
        self.log_wealth = [0.0] * n_eps      # log10 S_t per eps
        self.t = 0

    def update(self, p: float) -> float:
        """Feed one conformal p-value; return current log10 S_t."""
        # Clamp away from 0: a p-value of exactly 0 would make log
        # wealth diverge on a single observation, which is an artifact
        # of discrete score surfaces rather than real evidence.
        p = min(max(p, 1e-6), 1.0)
        self.t += 1
        for i, e in enumerate(self.eps):
            self.log_wealth[i] += math.log10(e) + (e - 1.0) * math.log10(p)
        return self.value

    @property
    def value(self) -> float:
        """log10 of the mixture wealth (log-sum-exp over the eps grid)."""
        if not self.log_wealth:
            return 0.0
        m = max(self.log_wealth)
        s = sum(10.0 ** (lw - m) for lw in self.log_wealth)
        return m + math.log10(s / len(self.log_wealth))

    def alarm(self, threshold_log10: float = 2.0) -> bool:
        """True once wealth exceeds 10^threshold (default 100 => FA <= 1%)."""
        return self.value >= threshold_log10


# ─────────────────────────────────────────────────────────────────────
# 1 + 2. The adaptive guard
# ─────────────────────────────────────────────────────────────────────

@dataclass
class StepLog:
    t: int
    score: float
    label: str
    allowed: bool
    audited: bool
    alpha_t: float
    threshold: float
    martingale_log10: float
    is_miss: bool          # malicious AND allowed (ground truth, for eval only)


@dataclass
class AdaptiveGuard:
    """Score-thresholding guard with ACI threshold control + random audit.

    The guard never sees labels except on audited steps. Everything it
    does at inference time uses only `score`; `label` is consumed solely
    to simulate the audit oracle and to score the run afterwards.
    """

    cal_scores: list[float]           # malicious calibration scores, sorted
    alpha_target: float = 0.05
    gamma: float = 0.05               # ACI learning rate (per audited step)
    audit_rate: float = 0.02          # rho
    seed: int = 0

    alpha_t: float = field(init=False)
    rng: random.Random = field(init=False)
    martingale: ConformalMartingale = field(init=False)
    log: list[StepLog] = field(default_factory=list, init=False)

    def __post_init__(self) -> None:
        self.cal_scores = sorted(self.cal_scores)
        self.alpha_t = self.alpha_target
        self.rng = random.Random(self.seed)
        self.martingale = ConformalMartingale()

    # -- conformal machinery -------------------------------------------------

    def threshold(self) -> float:
        """Allow iff score < threshold. Conformal alpha_t-quantile of cal."""
        n = len(self.cal_scores)
        k = math.floor(self.alpha_t * (n + 1))
        if k < 1:
            return 0.0                    # cannot certify: escalate everything
        if k > n:
            return float("inf")           # certify nothing: allow everything
        return self.cal_scores[k - 1]

    def p_value(self, score: float) -> float:
        """Conformal p-value of an observed score against calibration.

        Fraction of calibration scores at or below the observation, with
        the standard +1 smoothing. Small p = unusually low score for a
        malicious call = surprising if exchangeable.
        """
        n = len(self.cal_scores)
        le = sum(1 for s in self.cal_scores if s <= score)
        return (le + 1) / (n + 1)

    # -- the online loop -----------------------------------------------------

    def step(self, rec: Record, detector: str) -> StepLog:
        score = rec.scores[detector]
        t = self.threshold()

        would_allow = score < t
        audited = self.rng.random() < self.audit_rate
        # An audited call is escalated regardless of score — that is what
        # makes the audit sample unbiased.
        allowed = would_allow and not audited

        is_miss = rec.is_malicious and would_allow

        if audited:
            # Feedback is available only here. err_t is 1 when the guard
            # *would have* let a malicious call through.
            err = 1.0 if is_miss else 0.0
            self.alpha_t = min(max(self.alpha_t + self.gamma * (self.alpha_target - err), 0.0), 1.0)
            # Only malicious audits carry information about exchangeability
            # of the malicious score distribution, which is what the
            # calibration set describes.
            if rec.is_malicious:
                self.martingale.update(self.p_value(score))

        entry = StepLog(
            t=len(self.log),
            score=score,
            label=rec.label,
            allowed=allowed,
            audited=audited,
            alpha_t=self.alpha_t,
            threshold=t,
            martingale_log10=self.martingale.value,
            is_miss=is_miss,
        )
        self.log.append(entry)
        return entry


@dataclass
class StaticGuard:
    """Split-conformal baseline: calibrate once, never adapt.

    This is what every conformal-guard proposal in the literature does,
    and what Tier-1 showed breaks by 9.6x under source shift. Included
    so the two are scored on an identical stream.
    """

    cal_scores: list[float]
    alpha_target: float = 0.05

    def __post_init__(self) -> None:
        self.cal_scores = sorted(self.cal_scores)
        n = len(self.cal_scores)
        k = math.floor(self.alpha_target * (n + 1))
        self._t = 0.0 if k < 1 else (float("inf") if k > n else self.cal_scores[k - 1])
        self.log: list[StepLog] = []

    def step(self, rec: Record, detector: str) -> StepLog:
        score = rec.scores[detector]
        allowed = score < self._t
        entry = StepLog(
            t=len(self.log), score=score, label=rec.label,
            allowed=allowed, audited=False,
            alpha_t=self.alpha_target, threshold=self._t,
            martingale_log10=0.0,
            is_miss=rec.is_malicious and allowed,
        )
        self.log.append(entry)
        return entry


# ─────────────────────────────────────────────────────────────────────
# scoring
# ─────────────────────────────────────────────────────────────────────

def running_miss_rate(log: list[StepLog], window: int | None = None) -> list[float]:
    """Miss rate among malicious steps, cumulative or windowed."""
    out, hits, total = [], 0, 0
    from collections import deque
    buf: deque = deque(maxlen=window) if window else None
    for e in log:
        if e.label == "malicious":
            if buf is not None:
                buf.append(1 if e.is_miss else 0)
            else:
                hits += 1 if e.is_miss else 0
                total += 1
        if buf is not None:
            out.append(sum(buf) / len(buf) if buf else 0.0)
        else:
            out.append(hits / total if total else 0.0)
    return out


def summarize(log: list[StepLog], name: str, alpha_target: float) -> dict:
    mal = [e for e in log if e.label == "malicious"]
    ben = [e for e in log if e.label == "benign"]
    misses = sum(1 for e in mal if e.is_miss)
    escalated = sum(1 for e in log if not e.allowed)
    ben_esc = sum(1 for e in ben if not e.allowed)
    audits = sum(1 for e in log if e.audited)
    miss_rate = misses / len(mal) if mal else float("nan")
    return {
        "name": name,
        "steps": len(log),
        "n_malicious": len(mal),
        "alpha_target": alpha_target,
        "miss_rate": miss_rate,
        "violation_factor": miss_rate / alpha_target if alpha_target else float("nan"),
        "guarantee_held": miss_rate <= alpha_target,
        "abstention_rate": escalated / len(log) if log else float("nan"),
        "benign_tax": ben_esc / len(ben) if ben else float("nan"),
        "audit_rate": audits / len(log) if log else 0.0,
        "final_alpha_t": log[-1].alpha_t if log else float("nan"),
        "final_martingale_log10": log[-1].martingale_log10 if log else 0.0,
    }
