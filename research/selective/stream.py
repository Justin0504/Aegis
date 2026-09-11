"""Construct honest distribution-shift streams from the benchmark.

A streaming evaluation is only meaningful if the shift is real rather
than manufactured. We searched every (detector x split) pair in the
benchmark for one that satisfies three conditions simultaneously:

  * the detector exposes more than two distinct score values, so a
    threshold can actually move (rules out keyword blacklist and, as
    recorded, Llama-Guard);
  * static conformal calibration *holds* before the changepoint, so any
    later violation is attributable to the shift and not to a bad
    calibration;
  * the post-changepoint segment is long enough to observe adaptation,
    not just to observe breakage.

Exactly one pair qualifies:

    detector  GPT-4o-mini judge (4 distinct scores in the calibration
              segment)
    phase A   InjecAgent / data_exfiltration   (2,176 malicious)
    phase B   InjecAgent / unauthorized_action (1,020 malicious)

    static conformal at alpha=5%: 3.86% miss before, 20.00% after (4.0x)

The two phases are different attack semantics drawn from the same
corpus, so the shift is a genuine change in the conditional score
distribution rather than a change of annotator, format, or tooling.
Benign traffic is drawn from the same InjecAgent pool throughout and
interleaved at its natural rate, so the guard sees a realistic mix
rather than an all-attack stream.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from .loader import Record


@dataclass
class Stream:
    records: list[Record]
    changepoint: int          # index of the first post-shift record
    detector: str
    phase_a_desc: str
    phase_b_desc: str

    def __len__(self) -> int:
        return len(self.records)


def category_shift_stream(
    records: list[Record],
    detector: str = "llm_judge_openai",
    phase_a_category: str = "data_exfiltration",
    phase_b_category: str = "unauthorized_action",
    source: str = "injecagent",
    cal_frac: float = 0.5,
    benign_ratio: float = 0.4,
    seed: int = 0,
) -> tuple[list[Record], Stream]:
    """Return (calibration_malicious, stream).

    Calibration draws only from phase-A malicious records — this is the
    realistic setup, where you calibrate on the traffic you have seen so
    far. The remaining phase-A malicious records form the pre-shift
    segment so that in-distribution behaviour is measured out-of-sample.

    benign_ratio controls how much benign traffic is interleaved. It
    does not affect the miss-rate guarantee (which conditions on
    malicious calls) but it does drive the abstention and benign-tax
    numbers an operator actually feels.
    """
    rng = random.Random(seed)

    pool = [r for r in records if r.source == source]
    a_mal = [r for r in pool if r.is_malicious and r.category == phase_a_category]
    b_mal = [r for r in pool if r.is_malicious and r.category == phase_b_category]
    benign = [r for r in pool if not r.is_malicious]

    rng.shuffle(a_mal)
    rng.shuffle(b_mal)
    rng.shuffle(benign)

    n_cal = int(len(a_mal) * cal_frac)
    cal = a_mal[:n_cal]
    a_stream_mal = a_mal[n_cal:]

    # Split the benign pool proportionally between the two phases so the
    # benign rate is stable across the changepoint; a jump in benign rate
    # would be a second, confounding shift.
    def interleave(mal: list[Record], ben: list[Record]) -> list[Record]:
        n_ben = min(len(ben), int(len(mal) * benign_ratio / (1 - benign_ratio)))
        mixed = mal + ben[:n_ben]
        rng.shuffle(mixed)
        return mixed, ben[n_ben:]

    seg_a, benign_left = interleave(a_stream_mal, benign)
    seg_b, _ = interleave(b_mal, benign_left)

    stream = Stream(
        records=seg_a + seg_b,
        changepoint=len(seg_a),
        detector=detector,
        phase_a_desc=f"{source}/{phase_a_category}",
        phase_b_desc=f"{source}/{phase_b_category}",
    )
    return cal, stream


def describe(cal: list[Record], stream: Stream) -> None:
    a = stream.records[: stream.changepoint]
    b = stream.records[stream.changepoint:]
    def mal(rs): return sum(1 for r in rs if r.is_malicious)
    print(f"calibration      n={len(cal):5d}  (all malicious, {stream.phase_a_desc})")
    print(f"phase A  [0,{stream.changepoint})      n={len(a):5d}  malicious={mal(a):5d}  ({stream.phase_a_desc})")
    print(f"phase B  [{stream.changepoint},{len(stream)})   n={len(b):5d}  malicious={mal(b):5d}  ({stream.phase_b_desc})")
