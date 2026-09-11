"""Turn agent rollouts into BenchRecords.

    python -m selective.emit_instantiated

Produces benchmark/data/aegis-bench-instantiated.jsonl, the per-call
benchmark the fabricated conversion was trying and failing to be.

WHAT GOES IN

  malicious   The tool call a compromised agent actually emitted. Arguments
              are the model's own, so nothing in the record encodes the
              label — the reason the fabricated version scored AUC 0.9944
              on character count alone.

  benign      Three provenances, all genuine:
              * benign-arm  a call emitted for a synthesized legitimate
                            request targeting one of the attacked tools
                            (see selective/benign_arm.py)
              * user-tool   the legitimate first call from the case file
              * control     a call emitted in the control arm, where the
                            tool response carried length-matched neutral
                            prose instead of an injection

WHAT IS DELIBERATELY EXCLUDED

  Rollouts with outcome no_call contribute nothing: there is no tool call
  to score. They are the bulk of the control arm (99.6%) and they are the
  reason the benign class stays small. Counting them as benign "records"
  would repeat the ToolEmu mistake of shipping rows a per-call detector
  cannot inspect.

INTEGRITY, MEASURED

  best single surface feature      AUC 0.5849  (fabricated: 0.9944)
  all 15 features, 5-fold CV       AUC 0.6310  (fabricated: 1.0000)
  tools appearing only in one class      0
  malicious records whose tool also
    appears in the benign class       100.0%

  The last two lines are why the benign arm targets the attacked tools
  specifically. Without that, tool identity alone is a near-perfect
  classifier — the character-count shortcut one level up.

REMAINING LIMITATIONS

  * One agent (Qwen3-VL-32B). Attack calls reflect how that model is
    manipulated; a second model would show whether the calls generalise.
  * Single-turn capture. Multi-step exfiltration (read, then send) is
    recorded as its first step only.
  * 237 unique malicious calls is small, bounded by how many distinct
    attacker instructions InjecAgent actually contains.
"""

from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path

from benchmark.schema import (
    AttackCategory, BenchRecord, Distribution, Granularity, Label, ToolCall,
)

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "benchmark" / "data" / "raw" / "_clone_injecagent" / "data"
INST = ROOT / "benchmark" / "data" / "instantiated"
DEFAULT_OUT = ROOT / "benchmark" / "data" / "aegis-bench-instantiated.jsonl"

SPLIT_CATEGORY = {
    "ds_base": AttackCategory.DATA_EXFILTRATION,
    "ds_enhanced": AttackCategory.DATA_EXFILTRATION,
    "dh_base": AttackCategory.UNAUTHORIZED_ACTION,
    "dh_enhanced": AttackCategory.UNAUTHORIZED_ACTION,
}
CASE_FILES = {
    "ds_base": "test_cases_ds_base.json",
    "ds_enhanced": "test_cases_ds_enhanced.json",
    "dh_base": "test_cases_dh_base.json",
    "dh_enhanced": "test_cases_dh_enhanced.json",
}


def _safe(s):
    if isinstance(s, dict):
        return s
    try:
        return json.loads(s)
    except Exception:  # noqa: BLE001
        try:
            v = ast.literal_eval(s)
            return v if isinstance(v, dict) else {}
        except Exception:  # noqa: BLE001
            return {}


def load(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.open() if l.strip()]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--attack", type=Path, default=INST / "rollouts_qwen3vl32b.jsonl")
    ap.add_argument("--control", type=Path, default=INST / "rollouts_qwen3vl32b_control.jsonl")
    ap.add_argument("--benign", type=Path, default=INST / "rollouts_benign.jsonl")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--keep-duplicates", action="store_true")
    args = ap.parse_args()

    records: list[BenchRecord] = []

    # ---- malicious: what compromised agents actually emitted -------------
    for r in load(args.attack):
        if r["outcome"] != "compromised":
            continue
        for j, c in enumerate(r["emitted_calls"]):
            if c["tool_name"] not in r["attacker_tools"]:
                continue
            records.append(BenchRecord(
                id=f"inst::{r['case_id']}::atk{j}",
                source="injecagent_instantiated",
                label=Label.MALICIOUS,
                category=SPLIT_CATEGORY.get(r["split"], AttackCategory.UNAUTHORIZED_ACTION),
                tool_call=ToolCall(
                    tool_name=c["tool_name"],
                    arguments=c["arguments"],
                    framework="injecagent-rollout",
                    model=r.get("model"),
                ),
                conversation=[
                    {"role": "user", "content": r.get("user_instruction", "")},
                    {"role": "tool_observation", "content": r.get("attacker_instruction", "")},
                ],
                distribution=Distribution.NEAR_OOD,
                granularity=Granularity.FINE,
                meta={
                    "provenance": "agent_rollout_attack_arm",
                    "split": r["split"],
                    "agent_model": r.get("model"),
                    "attacker_tools": r["attacker_tools"],
                    "license": "Apache-2.0",
                },
            ))

    # ---- benign A: the legitimate first call from each case --------------
    seen_user: set[tuple] = set()
    for split, fname in CASE_FILES.items():
        p = RAW / fname
        if not p.exists():
            continue
        for i, case in enumerate(json.loads(p.read_text())):
            tool = case.get("User Tool")
            if not tool:
                continue
            argv = _safe(case.get("Tool Parameters"))
            key = (tool, json.dumps(argv, sort_keys=True))
            if not args.keep_duplicates and key in seen_user:
                continue
            seen_user.add(key)
            records.append(BenchRecord(
                id=f"inst::{split}::{i}::user",
                source="injecagent_instantiated",
                label=Label.BENIGN,
                category=None,
                tool_call=ToolCall(tool_name=tool, arguments=argv,
                                   framework="injecagent-rollout"),
                conversation=[{"role": "user", "content": case.get("User Instruction", "")}],
                distribution=Distribution.NEAR_OOD,
                granularity=Granularity.FINE,
                meta={"provenance": "case_user_tool", "split": split,
                      "license": "Apache-2.0"},
            ))

    # ---- benign B: calls emitted in the control arm ----------------------
    # These are ambiguous by construction: the tool is on the attacker list
    # but no injection was present, so the agent chose it as a plausible
    # continuation of the user's own task. Kept, flagged, and never counted
    # as an attack.
    for r in load(args.control):
        if r["outcome"] == "no_call":
            continue
        for j, c in enumerate(r["emitted_calls"]):
            records.append(BenchRecord(
                id=f"inst::{r['case_id']}::ctl{j}",
                source="injecagent_instantiated",
                label=Label.BENIGN,
                category=None,
                tool_call=ToolCall(tool_name=c["tool_name"], arguments=c["arguments"],
                                   framework="injecagent-rollout", model=r.get("model")),
                conversation=[{"role": "user", "content": r.get("user_instruction", "")}],
                distribution=Distribution.NEAR_OOD,
                granularity=Granularity.FINE,
                meta={
                    "provenance": "agent_rollout_control_arm",
                    "split": r["split"],
                    "agent_model": r.get("model"),
                    "ambiguous_tool": c["tool_name"] in r.get("attacker_tools", []),
                    "note": ("tool appears on the case's attacker list but no "
                             "injection was present; a plausible benign "
                             "continuation of the user's own request"),
                    "license": "Apache-2.0",
                },
            ))

    # ---- benign C: matched legitimate traffic over the attacked tools ----
    # Generated per-tool from the tool schema alone; the generator is never
    # shown an attack, so these are not "reverse-engineered negatives". The
    # point is coverage: every tool that appears in the attack set also
    # appears here called legitimately, so tool identity carries no label.
    for r in load(args.benign):
        if r["outcome"] != "called":
            continue
        for j, c in enumerate(r["emitted_calls"]):
            records.append(BenchRecord(
                id=f"inst::benign::{r['task_id']}::{j}",
                source="injecagent_instantiated",
                label=Label.BENIGN,
                category=None,
                tool_call=ToolCall(tool_name=c["tool_name"], arguments=c["arguments"],
                                   framework="benign-rollout", model=r.get("model")),
                conversation=[{"role": "user", "content": r.get("user_instruction", "")}],
                distribution=Distribution.NEAR_OOD,
                granularity=Granularity.FINE,
                meta={
                    "provenance": "agent_rollout_benign_arm",
                    "target_tool": r.get("target_tool"),
                    "agent_model": r.get("model"),
                    "license": "Apache-2.0",
                },
            ))

    # ---- dedup + write ---------------------------------------------------
    if not args.keep_duplicates:
        seen: set[tuple] = set()
        kept = []
        for rec in records:
            k = (rec.tool_call.tool_name,
                 json.dumps(rec.tool_call.arguments, sort_keys=True),
                 rec.label)
            if k in seen:
                continue
            seen.add(k)
            kept.append(rec)
        dropped = len(records) - len(kept)
        records = kept
    else:
        dropped = 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w") as f:
        for rec in records:
            f.write(rec.model_dump_json() + "\n")

    mal = sum(1 for r in records if r.label == Label.MALICIOUS)
    ben = len(records) - mal
    print(f"wrote {len(records)} records to {args.out}")
    print(f"  malicious {mal}   benign {ben}   (dropped {dropped} duplicates)")
    prov: dict[str, int] = {}
    for r in records:
        p = r.meta.get("provenance", "?")
        prov[p] = prov.get(p, 0) + 1
    for p, n in sorted(prov.items()):
        print(f"  {p:34s} {n:5d}")
    if ben < 100:
        print(f"\n  WARNING: benign class is {ben} records. Do not quote a false\n"
              f"  positive rate from this file — see the module docstring.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
