"""Failure complementarity — the empirical case for cascading at all.

Cascades are folklore: "chain a cheap detector to an expensive one and
you get the best of both." That argument only holds if the failures are
*complementary* — if detector B catches what A misses. If failures are
correlated, the cascade buys latency savings and nothing else, and you
should just run the best single detector.

Nobody publishes this matrix. We do.

Definitions (all on malicious records only, since a missed benign is a
false positive, not a safety failure):

    miss(A)              = malicious records A fails to block
    recovery(A -> B)     = |miss(A) & blocked(B)| / |miss(A)|
                           "of what A misses, what fraction does B save?"
    joint_miss(A, B)     = |miss(A) & miss(B)| / |malicious|
                           "what slips past BOTH"
    correlation phi      = phi coefficient between the two miss indicators
                           (0 = independent failures, 1 = identical failures)

The interesting cell is recovery(cheap -> expensive). If it's near 1.0,
the cascade is sound. If it's near the expensive detector's standalone
recall, the cheap layer contributes nothing but a latency shortcut.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass

from .loader import DISPLAY, FULL_BENCH_RUNS, Record


@dataclass
class PairStats:
    a: str
    b: str
    n_malicious: int
    miss_a: int
    miss_b: int
    joint_miss: int
    recovery_a_to_b: float      # of A's misses, fraction B blocks
    recovery_b_to_a: float
    phi: float                  # failure correlation
    union_recall: float         # recall if you OR the two detectors


def _phi(n11: int, n10: int, n01: int, n00: int) -> float:
    """Phi coefficient for two binary variables (here: miss_A, miss_B)."""
    num = n11 * n00 - n10 * n01
    den = math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00))
    return num / den if den else 0.0


def pair_stats(records: list[Record], a: str, b: str) -> PairStats:
    mal = [r for r in records if r.is_malicious]
    n = len(mal)

    miss_a = {r.record_id for r in mal if not r.blocked_by(a)}
    miss_b = {r.record_id for r in mal if not r.blocked_by(b)}
    joint = miss_a & miss_b

    # 2x2 contingency over miss indicators
    n11 = len(joint)                                    # both miss
    n10 = len(miss_a - miss_b)                          # A misses, B catches
    n01 = len(miss_b - miss_a)                          # B misses, A catches
    n00 = n - n11 - n10 - n01                           # both catch

    return PairStats(
        a=a, b=b, n_malicious=n,
        miss_a=len(miss_a), miss_b=len(miss_b), joint_miss=n11,
        recovery_a_to_b=(len(miss_a - miss_b) / len(miss_a)) if miss_a else float("nan"),
        recovery_b_to_a=(len(miss_b - miss_a) / len(miss_b)) if miss_b else float("nan"),
        phi=_phi(n11, n10, n01, n00),
        union_recall=1.0 - (n11 / n) if n else float("nan"),
    )


def recovery_matrix(records: list[Record], detectors: list[str]) -> dict:
    """Full pairwise recovery + correlation matrices."""
    out = {"recovery": {}, "phi": {}, "union_recall": {}, "standalone_recall": {}}

    mal = [r for r in records if r.is_malicious]
    for d in detectors:
        blocked = sum(1 for r in mal if r.blocked_by(d))
        out["standalone_recall"][d] = blocked / len(mal) if mal else 0.0

    for a, b in itertools.permutations(detectors, 2):
        st = pair_stats(records, a, b)
        out["recovery"].setdefault(a, {})[b] = st.recovery_a_to_b
        out["phi"].setdefault(a, {})[b] = st.phi
        out["union_recall"].setdefault(a, {})[b] = st.union_recall
    return out


def report(records: list[Record], detectors: list[str] | None = None, scope: str = "all") -> dict:
    detectors = detectors or [d for d in FULL_BENCH_RUNS if d != "no_defense"]
    m = recovery_matrix(records, detectors)

    mal = sum(1 for r in records if r.is_malicious)
    print(f"\n{'=' * 78}")
    print(f"FAILURE COMPLEMENTARITY  [{scope}]  n_malicious={mal}")
    print("=" * 78)

    print("\nStandalone recall (block rate on malicious):")
    for d in detectors:
        print(f"  {DISPLAY[d]:26s} {m['standalone_recall'][d]:6.1%}")

    print("\nRecovery: of the attacks ROW misses, what % does COLUMN catch?")
    print("  (high = complementary failures = cascade is justified)")
    hdr = "  " + " " * 26 + "".join(f"{DISPLAY[d][:11]:>13s}" for d in detectors)
    print(hdr)
    for a in detectors:
        cells = []
        for b in detectors:
            if a == b:
                cells.append(f"{'—':>13s}")
            else:
                v = m["recovery"][a][b]
                cells.append(f"{v:12.1%} " if v == v else f"{'n/a':>13s}")
        print(f"  {DISPLAY[a]:26s}" + "".join(cells))

    print("\nFailure correlation (phi over miss indicators):")
    print("  (0 = independent failures; 1 = the two fail on identical inputs)")
    print(hdr)
    for a in detectors:
        cells = []
        for b in detectors:
            if a == b:
                cells.append(f"{'—':>13s}")
            else:
                cells.append(f"{m['phi'][a][b]:13.3f}")
        print(f"  {DISPLAY[a]:26s}" + "".join(cells))

    # The load-bearing question: does the best 2-detector union beat the
    # best single detector by enough to pay for the second detector?
    best_single = max(detectors, key=lambda d: m["standalone_recall"][d])
    best_pair, best_union = None, -1.0
    for a, b in itertools.combinations(detectors, 2):
        u = m["union_recall"][a][b]
        if u > best_union:
            best_union, best_pair = u, (a, b)

    print(f"\nBest single detector: {DISPLAY[best_single]} @ {m['standalone_recall'][best_single]:.1%}")
    print(f"Best 2-detector union: {DISPLAY[best_pair[0]]} + {DISPLAY[best_pair[1]]} @ {best_union:.1%}")
    print(f"Marginal gain from the second detector: {best_union - m['standalone_recall'][best_single]:+.1%}")

    return {
        **m,
        "best_single": best_single,
        "best_pair": list(best_pair),
        "best_union_recall": best_union,
        "marginal_gain": best_union - m["standalone_recall"][best_single],
        "n_malicious": mal,
        "scope": scope,
    }
