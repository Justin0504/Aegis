"""AEGIS-SC experiment: does the guard repair its own guarantee?

    python -m selective.run_adaptive

Compares, on one identical shift stream:

    static      split-conformal calibrated once (what the literature does)
    aegis-sc    ACI threshold control + random audit + shift martingale

and sweeps the audit rate to expose the operator's actual dial: how much
auditing does it cost to recover within N calls of a shift?

Writes results/selective/adaptive.json.
"""

from __future__ import annotations

import json
from pathlib import Path

from .adaptive import AdaptiveGuard, StaticGuard, summarize
from .loader import DISPLAY, load
from .stream import category_shift_stream, describe

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "results" / "selective"

ALPHA = 0.05
GAMMA = 0.05
AUDIT_RATES = (0.005, 0.01, 0.02, 0.05, 0.10)


def _phase_miss(log, lo: int, hi: int) -> float:
    seg = [e for e in log[lo:hi] if e.label == "malicious"]
    return sum(1 for e in seg if e.is_miss) / len(seg) if seg else float("nan")


def _recovery_step(log, changepoint: int, alpha: float, window: int = 200) -> int | None:
    """First post-shift index at which the windowed miss rate is back <= alpha.

    Uses a trailing window over malicious steps only. Returns None if the
    guard never recovers within the stream.
    """
    from collections import deque
    buf: deque = deque(maxlen=window)
    for i in range(changepoint, len(log)):
        e = log[i]
        if e.label != "malicious":
            continue
        buf.append(1 if e.is_miss else 0)
        if len(buf) == window and sum(buf) / window <= alpha:
            return i - changepoint
    return None


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    records = load()
    cal_recs, stream = category_shift_stream(records, seed=0)
    det = stream.detector
    cal_scores = [r.scores[det] for r in cal_recs]

    print("=" * 88)
    print("AEGIS-SC — guarantee repair under distribution shift")
    print("=" * 88)
    print(f"detector: {DISPLAY[det]}   alpha_target={ALPHA:.0%}   gamma={GAMMA}")
    describe(cal_recs, stream)

    out: dict = {
        "detector": det,
        "alpha_target": ALPHA,
        "gamma": GAMMA,
        "changepoint": stream.changepoint,
        "stream_len": len(stream),
        "phase_a": stream.phase_a_desc,
        "phase_b": stream.phase_b_desc,
        "runs": [],
    }

    # ---- baseline: static split conformal --------------------------------
    static = StaticGuard(cal_scores, alpha_target=ALPHA)
    for r in stream.records:
        static.step(r, det)
    s = summarize(static.log, "static split-conformal", ALPHA)
    s["phase_a_miss"] = _phase_miss(static.log, 0, stream.changepoint)
    s["phase_b_miss"] = _phase_miss(static.log, stream.changepoint, len(stream))
    s["recovery_steps"] = None
    out["runs"].append(s)

    print(f"\n{'-' * 88}")
    print(f"{'configuration':34s} {'A miss':>8s} {'B miss':>8s} {'overall':>8s} "
          f"{'x bound':>8s} {'abstain':>8s} {'recovery':>9s}")
    print("-" * 88)
    print(f"{'static split-conformal':34s} {s['phase_a_miss']:7.2%} {s['phase_b_miss']:7.2%} "
          f"{s['miss_rate']:7.2%} {s['violation_factor']:7.1f}x {s['abstention_rate']:7.1%} "
          f"{'never':>9s}")

    # ---- AEGIS-SC across audit rates -------------------------------------
    for rho in AUDIT_RATES:
        g = AdaptiveGuard(cal_scores, alpha_target=ALPHA, gamma=GAMMA,
                          audit_rate=rho, seed=0)
        for r in stream.records:
            g.step(r, det)
        a = summarize(g.log, f"aegis-sc rho={rho:.1%}", ALPHA)
        a["audit_rate_nominal"] = rho
        a["phase_a_miss"] = _phase_miss(g.log, 0, stream.changepoint)
        a["phase_b_miss"] = _phase_miss(g.log, stream.changepoint, len(stream))
        rec = _recovery_step(g.log, stream.changepoint, ALPHA)
        a["recovery_steps"] = rec
        # shift alarm: first post-changepoint step where martingale > 10^2
        alarm = next((i - stream.changepoint for i in range(stream.changepoint, len(g.log))
                      if g.log[i].martingale_log10 >= 2.0), None)
        a["alarm_steps"] = alarm
        out["runs"].append(a)

        rec_s = f"{rec}" if rec is not None else "never"
        print(f"{'AEGIS-SC  audit=' + f'{rho:.1%}':34s} {a['phase_a_miss']:7.2%} "
              f"{a['phase_b_miss']:7.2%} {a['miss_rate']:7.2%} "
              f"{a['violation_factor']:7.1f}x {a['abstention_rate']:7.1%} {rec_s:>9s}")

    print("-" * 88)
    print("A miss / B miss = miss rate before / after the changepoint")
    print("recovery = malicious steps after the shift until the trailing-200 "
          "miss rate is back under alpha")

    # ---- shift alarm -------------------------------------------------------
    print(f"\nSHIFT ALARM (conformal test martingale, log10 wealth >= 2 => FA <= 1%)")
    for a in out["runs"]:
        if "alarm_steps" in a:
            al = a["alarm_steps"]
            print(f"  audit={a['audit_rate_nominal']:.1%}  "
                  f"alarm at +{al} steps" if al is not None else
                  f"  audit={a['audit_rate_nominal']:.1%}  no alarm raised "
                  f"(final log10 S = {a['final_martingale_log10']:.2f})")

    (OUT / "adaptive.json").write_text(json.dumps(out, indent=2, default=str))
    print(f"\nwrote {OUT / 'adaptive.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
