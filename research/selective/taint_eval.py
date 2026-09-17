"""Does provenance separate what content cannot?

The L1 pattern engine fires on 0.4% of real attack calls because those
calls have no payload: AmazonViewSavedAddresses({}) is syntactically
indistinguishable from a legitimate one. If anything separates the two it
has to be provenance, not content.

cascade/features.py already carries five taint features for exactly this.
This module derives taint labels for the instantiated benchmark and asks
whether they help.

DERIVING TAINT HONESTLY

A deployed gateway knows, at call time, which context the agent was
looking at and where each argument value came from. We reconstruct the
same thing from the rollout transcripts:

    untrusted   an argument whose value appears in (or is derived from)
                a tool observation the agent read before this call
    trusted     an argument traceable to the user's own instruction
    hop         0 when the value came from the user turn, 1 when it came
                through one tool response

THE CONTROL THAT MAKES THIS MEANINGFUL

Attack records all follow a tool observation; single-step benign records
follow none. "Was there a tool observation?" would therefore separate
the classes perfectly for a construction reason, and a taint model
trained on that would be learning the same kind of artifact as the
`_attacker_instruction` key.

So the comparison that matters is against the TWO-STEP benign arm
(selective/benign_twostep.py), where a legitimate call also carries
arguments derived from a tool response. Both classes then have
untrusted-derived data; the only remaining difference is whether the
*instruction* came from the untrusted channel.

If the five taint features separate attack from two-step benign, data
provenance is enough. If they do not, the signal lives in instruction
provenance — a quantity the current feature set does not encode, and a
concrete thing to build next.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from benchmark.schema import BenchRecord
from cascade.features import TaintInfo, encode, encode_with_taint

ROOT = Path(__file__).resolve().parents[1]
BENCH = ROOT / "benchmark" / "data" / "aegis-bench-instantiated.jsonl"
INST = ROOT / "benchmark" / "data" / "instantiated"

# Tools whose effect leaves the user's own account — the sinks that make
# an untrusted argument dangerous rather than merely odd.
SINK_HINTS = ("send", "email", "post", "upload", "share", "transfer",
              "pay", "write", "delete", "create", "dispatch", "grant",
              "execute", "download")


def is_sink(tool_name: str) -> bool:
    n = tool_name.lower()
    return any(h in n for h in SINK_HINTS)


def _observation_text(rec: BenchRecord) -> str:
    """Everything the agent read from tools before making this call."""
    return " ".join(
        str(m.get("content", ""))
        for m in (rec.conversation or [])
        if m.get("role") in ("tool_observation", "tool")
    )


def _user_text(rec: BenchRecord) -> str:
    return " ".join(
        str(m.get("content", ""))
        for m in (rec.conversation or [])
        if m.get("role") == "user"
    )


def derive_taint(rec: BenchRecord) -> TaintInfo:
    """Label each argument by where its value plausibly came from.

    A value is called untrusted when it occurs in the tool observation
    the agent read. This is the same substring-provenance test a gateway
    taint tracker performs; it is deliberately simple so the result is
    about the *feature set*, not about a clever attribution heuristic.
    """
    obs = _observation_text(rec).lower()
    usr = _user_text(rec).lower()
    labels: dict[str, str] = {}
    sources: dict[str, str] = {}
    hops: dict[str, int] = {}

    for k, v in (rec.tool_call.arguments or {}).items():
        val = json.dumps(v) if not isinstance(v, str) else v
        probe = val.strip().strip('"').lower()
        if len(probe) < 3:
            labels[k], sources[k], hops[k] = "unknown", "none", 0
            continue
        if obs and probe in obs:
            labels[k], sources[k], hops[k] = "untrusted", "tool_obs", 1
        elif usr and probe in usr:
            labels[k], sources[k], hops[k] = "trusted", "user", 0
        else:
            # Model-authored value with no traceable origin. Treated as
            # unknown rather than trusted: a gateway cannot vouch for it.
            labels[k], sources[k], hops[k] = "unknown", "model", 0

    return TaintInfo(trust_labels=labels, source_ids=sources,
                     hop_distance=hops, is_sink=is_sink(rec.tool_call.tool_name))


@dataclass
class Arm:
    name: str
    records: list[BenchRecord]


def load_records() -> list[BenchRecord]:
    return [BenchRecord.model_validate_json(l)
            for l in BENCH.open() if l.strip()]


def load_twostep() -> list[BenchRecord]:
    """Two-step benign rollouts, reconstructed as BenchRecords."""
    path = INST / "rollouts_benign_twostep.jsonl"
    if not path.exists():
        return []
    from benchmark.schema import Distribution, Granularity, Label, ToolCall
    out = []
    for line in path.open():
        if not line.strip():
            continue
        r = json.loads(line)
        if r["outcome"] != "called":
            continue
        for j, c in enumerate(r["emitted_calls"]):
            out.append(BenchRecord(
                id=f"inst::twostep::{r['task_id']}::{j}",
                source="injecagent_instantiated",
                label=Label.BENIGN,
                category=None,
                tool_call=ToolCall(tool_name=c["tool_name"], arguments=c["arguments"],
                                   framework="benign-twostep", model=r.get("model")),
                conversation=[
                    {"role": "user", "content": r.get("user_instruction", "")},
                    {"role": "tool_observation", "content": r.get("lookup_result", "")},
                ],
                distribution=Distribution.NEAR_OOD,
                granularity=Granularity.FINE,
                meta={"provenance": "agent_rollout_benign_twostep",
                      "lookup_tool": r.get("lookup_tool"),
                      "action_tool": r.get("action_tool")},
            ))
    return out


def evaluate(mal: list[BenchRecord], ben: list[BenchRecord], label: str) -> dict:
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import roc_auc_score
    from sklearn.model_selection import cross_val_score
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    recs = mal + ben
    y = np.array([1] * len(mal) + [0] * len(ben))
    base = np.vstack([encode(r.tool_call).vector for r in recs])
    full = np.vstack([encode_with_taint(r.tool_call, derive_taint(r)).vector
                      for r in recs])
    taint_only = full[:, 15:]

    def cv(X: np.ndarray) -> tuple[float, float]:
        if len(set(y)) < 2 or min(np.bincount(y)) < 5:
            return float("nan"), float("nan")
        s = cross_val_score(
            make_pipeline(StandardScaler(), LogisticRegression(max_iter=3000)),
            X, y, cv=5, scoring="roc_auc")
        return float(s.mean()), float(s.std())

    b_m, b_s = cv(base)
    t_m, t_s = cv(taint_only)
    f_m, f_s = cv(full)

    names = ["untrusted_frac", "source_entropy", "max_hop", "sink_untrusted",
             "cross_source"]
    per = {}
    for i, nm in enumerate(names):
        col = taint_only[:, i]
        per[nm] = {
            "mal_mean": float(col[y == 1].mean()),
            "ben_mean": float(col[y == 0].mean()),
            "auc": float(roc_auc_score(y, col)) if col.std() > 0 else 0.5,
        }

    print(f"\n{'=' * 74}")
    print(f"{label}   malicious={len(mal)}  benign={len(ben)}")
    print("=" * 74)
    print(f"  base 15 features        AUC {b_m:.4f} +/- {b_s:.4f}")
    print(f"  taint 5 features        AUC {t_m:.4f} +/- {t_s:.4f}")
    print(f"  all 20 features         AUC {f_m:.4f} +/- {f_s:.4f}")
    print(f"  lift from taint         {f_m - b_m:+.4f}")
    print("\n  per taint feature:")
    print(f"    {'feature':18s} {'mal':>8s} {'ben':>8s} {'AUC':>8s}")
    for nm, d in per.items():
        print(f"    {nm:18s} {d['mal_mean']:8.3f} {d['ben_mean']:8.3f} {d['auc']:8.4f}")

    return {"label": label, "n_mal": len(mal), "n_ben": len(ben),
            "base_auc": b_m, "taint_auc": t_m, "full_auc": f_m,
            "lift": f_m - b_m, "per_feature": per}


def main() -> int:
    recs = load_records()
    mal = [r for r in recs if r.label == "malicious"]
    ben_1step = [r for r in recs if r.label == "benign"]
    ben_2step = load_twostep()

    out = {}
    out["vs_singlestep"] = evaluate(
        mal, ben_1step,
        "A. attack vs SINGLE-step benign  (expect inflation: benign has no tool_obs)")

    if ben_2step:
        out["vs_twostep"] = evaluate(
            mal, ben_2step,
            "B. attack vs TWO-step benign  (the honest comparison)")
        a, b = out["vs_singlestep"]["taint_auc"], out["vs_twostep"]["taint_auc"]
        print(f"\n{'=' * 74}")
        print("TAINT FEATURES, HONEST vs INFLATED")
        print(f"  against single-step benign : AUC {a:.4f}")
        print(f"  against two-step benign    : AUC {b:.4f}")
        print(f"  drop attributable to the construction artifact: {a - b:+.4f}")
    else:
        print("\n  (two-step benign arm not built yet — run "
              "selective.benign_twostep for comparison B)")

    dest = ROOT / "results" / "selective" / "taint.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, indent=2))
    print(f"\nwrote {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
