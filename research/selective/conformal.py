"""Conformal risk control for agent guards — a guarantee, not a test-set number.

Motivation. Every number in the agent-safety literature is an empirical
recall on a held-out split: "we block 99.9%." That statement says
nothing about the next call the guard sees. Conformal prediction gives
a *distribution-free, finite-sample* guarantee instead:

    With probability >= 1 - delta over the calibration draw, the guard's
    miss rate on exchangeable future traffic is at most alpha.

The price is abstention: calls the guard cannot confidently clear get
escalated (to a more expensive layer, or to a human). The abstention
rate is the honest cost of the guarantee, and it is the quantity that
should be reported alongside recall.

Method (split conformal, one-sided lower quantile, on the malicious class).

    The guard ALLOWS a call when risk_score < t and ESCALATES otherwise.
    The safety failure is a malicious call that falls below t and is
    therefore allowed silently. So we need

        P(risk_score < t | malicious) <= alpha

    which makes t the alpha-quantile of the malicious score distribution,
    with a finite-sample correction:

    1. Split labelled data into calibration (n malicious) and test.
    2. Sort the malicious calibration risk_scores ascending: s_(1) .. s_(n).
    3. Set t = s_(k) with k = floor(alpha * (n + 1)). For an exchangeable
       new malicious point, P(s_new < s_(k)) <= k / (n+1) <= alpha. The
       (n+1) is what makes this finite-sample exact rather than asymptotic.
       If k < 1 the sample is too small to certify that alpha at all, and
       we fall back to t = 0 (escalate everything, miss rate 0).
    4. At test time: ALLOW iff risk_score < t, else ESCALATE.

    Guarantee: P(malicious call silently allowed) <= alpha.

    Ties. Coarse score surfaces produce heavy ties at s_(k). Conformal
    stays *valid* under ties but becomes conservative — realised miss
    rate lands well below alpha while abstention overshoots. That gap is
    the efficiency cost of an uncalibrated detector and we report it.

Why the guarantee can still fail. Conformal coverage assumes calibration
and test are *exchangeable*. Distribution shift breaks exchangeability,
and the guarantee breaks with it. We exploit this deliberately: by
calibrating on one source and testing on another we can measure how far
realised risk drifts from the nominal alpha. That gap is a direct,
quantitative answer to "is my guard still working?" — which is the
question this whole package exists to ask.

Caveat on score granularity. Several detectors expose only 2-13 distinct
score values (see loader.summarize). Conformal remains *valid* under
coarse scores — validity never depends on the score being good — but it
becomes inefficient: qhat lands on a plateau and the abstention rate
jumps in large steps rather than tuning smoothly. We report the achieved
step sizes so the inefficiency is visible rather than hidden.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass

from .loader import DISPLAY, Record


@dataclass
class ConformalResult:
    detector: str
    alpha: float                 # nominal max miss rate on malicious
    n_cal_mal: int
    n_test_mal: int
    n_test_ben: int
    allow_threshold: float       # ALLOW iff risk_score < this
    certifiable: bool            # False when n_cal is too small for this alpha
    realised_miss_rate: float    # fraction of malicious silently allowed
    abstention_rate: float       # fraction of ALL test traffic escalated
    benign_abstention: float     # fraction of benign traffic escalated (the tax)
    guarantee_held: bool

    def line(self) -> str:
        if not self.certifiable:
            return (
                f"  {DISPLAY.get(self.detector, self.detector):26s} "
                f"alpha={self.alpha:.2f}  [NOT CERTIFIABLE: n_cal too small]"
            )
        ok = "held    " if self.guarantee_held else "VIOLATED"
        slack = self.alpha - self.realised_miss_rate
        return (
            f"  {DISPLAY.get(self.detector, self.detector):26s} "
            f"a={self.alpha:.2f}  t={self.allow_threshold:.3f}  "
            f"miss={self.realised_miss_rate:6.2%}  "
            f"slack={slack:+6.2%}  "
            f"abstain={self.abstention_rate:6.1%}  "
            f"benign_tax={self.benign_abstention:6.1%}  [{ok}]"
        )


def calibrate(
    cal: list[Record],
    detector: str,
    alpha: float,
) -> tuple[float, bool]:
    """Return (allow_threshold, certifiable) from malicious calibration records.

    allow_threshold t is the conformal alpha-quantile of malicious scores:
    a new exchangeable malicious call falls below t with probability
    <= alpha. `certifiable` is False when floor(alpha*(n+1)) < 1, i.e.
    the calibration set is too small to certify that alpha at any
    threshold — in which case we return t=0 (escalate everything).
    """
    mal = [r for r in cal if r.is_malicious]
    if not mal:
        raise ValueError("calibration set contains no malicious records")
    scores = sorted(r.scores[detector] for r in mal)
    n = len(scores)
    k = math.floor(alpha * (n + 1))
    if k < 1:
        return 0.0, False
    return scores[k - 1], True


def evaluate(
    cal: list[Record],
    test: list[Record],
    detector: str,
    alpha: float,
) -> ConformalResult:
    t, certifiable = calibrate(cal, detector, alpha)

    test_mal = [r for r in test if r.is_malicious]
    test_ben = [r for r in test if not r.is_malicious]

    def allowed(r: Record) -> bool:
        return r.scores[detector] < t

    missed = sum(1 for r in test_mal if allowed(r))
    miss_rate = missed / len(test_mal) if test_mal else float("nan")

    escalated_all = sum(1 for r in test if not allowed(r))
    escalated_ben = sum(1 for r in test_ben if not allowed(r))

    return ConformalResult(
        detector=detector,
        alpha=alpha,
        n_cal_mal=sum(1 for r in cal if r.is_malicious),
        n_test_mal=len(test_mal),
        n_test_ben=len(test_ben),
        allow_threshold=t,
        certifiable=certifiable,
        realised_miss_rate=miss_rate,
        abstention_rate=escalated_all / len(test) if test else float("nan"),
        benign_abstention=escalated_ben / len(test_ben) if test_ben else float("nan"),
        guarantee_held=(miss_rate <= alpha) if test_mal else True,
    )


def iid_split(
    records: list[Record],
    cal_frac: float = 0.5,
    seed: int = 0,
) -> tuple[list[Record], list[Record]]:
    """Exchangeable split — the setting where the guarantee should hold."""
    rng = random.Random(seed)
    shuffled = list(records)
    rng.shuffle(shuffled)
    k = int(len(shuffled) * cal_frac)
    return shuffled[:k], shuffled[k:]


def source_split(
    records: list[Record],
    cal_sources: set[str],
) -> tuple[list[Record], list[Record]]:
    """Non-exchangeable split — calibrate on one source, test on others.

    This deliberately violates the conformal assumption so we can measure
    how badly the guarantee degrades under realistic shift.
    """
    cal = [r for r in records if r.source in cal_sources]
    test = [r for r in records if r.source not in cal_sources]
    return cal, test


def sweep(
    records: list[Record],
    detectors: list[str],
    alphas: tuple[float, ...] = (0.01, 0.05, 0.10, 0.20),
    seed: int = 0,
) -> dict:
    """Run both split regimes across alphas. Returns a JSON-able summary."""
    out: dict = {"iid": [], "shift": []}

    cal_i, test_i = iid_split(records, seed=seed)
    print(f"\n{'=' * 92}")
    print("CONFORMAL RISK CONTROL — exchangeable split (guarantee SHOULD hold)")
    print(f"  calibration n={len(cal_i)}   test n={len(test_i)}")
    print("=" * 92)
    for alpha in alphas:
        print(f"\n  target miss rate alpha = {alpha:.0%}")
        for d in detectors:
            res = evaluate(cal_i, test_i, d, alpha)
            print(res.line())
            out["iid"].append(res.__dict__)

    # Shift regime: calibrate on the dominant source, test on the rest.
    cal_s, test_s = source_split(records, cal_sources={"injecagent"})
    print(f"\n{'=' * 92}")
    print("CONFORMAL RISK CONTROL — source shift (exchangeability VIOLATED)")
    print(f"  calibrate on injecagent n={len(cal_s)}   test on held-out sources n={len(test_s)}")
    print("=" * 92)
    for alpha in alphas:
        print(f"\n  target miss rate alpha = {alpha:.0%}")
        for d in detectors:
            res = evaluate(cal_s, test_s, d, alpha)
            print(res.line())
            out["shift"].append(res.__dict__)

    return out
