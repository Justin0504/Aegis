"""Instruction provenance as a step-level detector on AgentDrift.

    python -m selective.agentdrift_eval            # → results/selective/agentdrift.json

AgentDrift (Pinjari & Saint-Germain, arXiv:2609.06972, CC BY 4.0) is
12,536 synthetic tool-call trajectories in which every step carries one of
four labels: benign, injection_point (the step whose observation carries
the injection; the call itself is legitimate), hijacked (a call the
injection caused) and failed_injection (the agent saw the injection and
did not follow it). Its baseline, a surface-feature logistic regression
over the step, recovers 55.4% of attacks at F1 0.647, and finds 8.2% of
partial hijacks and 23.1% of delayed executions.

This replays each trajectory through the SHIPPING gateway the way the SDK
reports a live agent: the task is the user turn; before each step the call
is checked with the ledger holding every earlier observation as untrusted;
after each step the step's observation is appended. The gateway never
sees a label. A step is "flagged" when the pack blocks or holds it.

Positive class: hijacked. Negative: benign, failed_injection and
injection_point (the call at the injection point is the agent's own, made
before it read the injection). Reported per step and per trajectory,
overall and by the dataset's attack type and category, on the
task-disjoint test and validation splits.

The corpus is synthetic (one open model generated it), and its hijacked
calls are, by construction, ones an injection asked for; that is the
provenance layer's home ground, and the number should be read with that
in mind. What it adds over the paper's own corpus is scale (tens of
thousands of labelled steps), five domains, delayed and partial hijacks,
and 1,500 hard negatives written to look like hijacks.
"""
from __future__ import annotations

import json
import sys
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from selective.provenance_gateway_eval import _gw, start_gateway, PACK  # noqa: E402

DATA = ROOT / "external" / "AgentDrift" / "data_taskdisjoint"
OUT = ROOT / "results" / "selective"
SPLITS = ("test", "val")


def load(split: str) -> list[dict]:
    return [json.loads(l) for l in (DATA / f"{split}.jsonl").open()]


def replay(traj: dict, key: str) -> list[dict]:
    sid = f"agentdrift::{traj['id']}"
    agent = f"agentdrift-{traj['agent']}"
    events = [{"seq": 0, "channel": "user", "text": str(traj["task"])[:32_000], "source": "task"}]
    _gw("POST", "/api/v1/context", {"session_id": sid, "agent_id": agent, "events": events}, key)
    rows = []
    for i, step in enumerate(traj["steps"]):
        payload = {"agent_id": agent, "session_id": sid, "tool_name": step["tool"],
                   "arguments": step.get("args") or {}, "framework": "agentdrift"}
        for attempt in range(8):
            try:
                body = _gw("POST", "/api/v1/check", payload, key)
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 7:
                    raise
                time.sleep(0.25 * (2 ** attempt))
        dsl = body.get("dsl") or {}
        rows.append({"traj": traj["id"], "step": i, "tool": step["tool"], "label": step["label"],
                     "decision": body.get("decision"), "rule": dsl.get("rule") or "",
                     "flag": body.get("decision") in ("block", "pending")})
        obs = step.get("obs")
        if obs:
            _gw("POST", "/api/v1/context", {"session_id": sid, "agent_id": agent, "events": [
                {"seq": i + 1, "channel": "untrusted", "text": str(obs)[:32_000], "source": step["tool"]}]}, key)
    _gw("DELETE", "/api/v1/context", {"session_id": sid}, key)
    return rows


def prf(tp: int, fp: int, fn: int) -> dict:
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return {"precision": round(p, 4), "recall": round(r, 4), "f1": round(f, 4), "tp": tp, "fp": fp, "fn": fn}


def step_metrics(rows: list[dict]) -> dict:
    tp = sum(1 for r in rows if r["label"] == "hijacked" and r["flag"])
    fn = sum(1 for r in rows if r["label"] == "hijacked" and not r["flag"])
    fp = sum(1 for r in rows if r["label"] != "hijacked" and r["flag"])
    out = prf(tp, fp, fn)
    by_label = defaultdict(lambda: [0, 0])
    for r in rows:
        by_label[r["label"]][0] += r["flag"]; by_label[r["label"]][1] += 1
    out["flag_rate_by_label"] = {k: {"flagged": v[0], "n": v[1], "rate": round(v[0] / v[1], 4)} for k, v in by_label.items()}
    return out


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    gw = start_gateway(OUT / "agentdrift.log")
    try:
        key = _gw("GET", "/api/v1/auth/key")["api_key"]
        applied = _gw("POST", f"/api/v1/dsl/packs/{PACK}/apply", {}, key)
        print(f"gateway up; pack rules: {applied.get('rule_count')}")
        rows: list[dict] = []
        trajs: dict[str, dict] = {}
        t0 = time.time()
        for split in SPLITS:
            for n, traj in enumerate(load(split)):
                trajs[traj["id"]] = traj
                rows.extend(replay(traj, key))
                if n % 250 == 0:
                    print(f"  {split} {n}  {len(rows)} steps  {time.time() - t0:.0f}s", flush=True)
    finally:
        gw.terminate()

    # Per trajectory: an attacked trajectory is caught if any hijacked step is flagged;
    # a clean trajectory (no hijacked step) is a false alarm if any step is flagged.
    per_traj = defaultdict(list)
    for r in rows:
        per_traj[r["traj"]].append(r)
    t_tp = t_fn = t_fp = 0
    by_attack = defaultdict(lambda: [0, 0])
    by_cat = defaultdict(lambda: [0, 0])
    for tid, rs in per_traj.items():
        hij = [r for r in rs if r["label"] == "hijacked"]
        if hij:
            caught = any(r["flag"] for r in hij)
            t_tp += caught; t_fn += not caught
            by_attack[trajs[tid].get("attack_type") or "?"][0] += caught
            by_attack[trajs[tid].get("attack_type") or "?"][1] += 1
        else:
            t_fp += any(r["flag"] for r in rs)
        c = trajs[tid].get("category") or "?"
        by_cat[c][0] += any(r["flag"] for r in rs); by_cat[c][1] += 1

    summary = {
        "dataset": "AgentDrift v2.0 task-disjoint test+val", "splits": list(SPLITS), "pack": PACK,
        "n_trajectories": len(per_traj), "n_steps": len(rows),
        "step": step_metrics(rows),
        "trajectory": {**prf(t_tp, t_fp, t_fn), "clean_trajectories_flagged": t_fp,
                       "clean_trajectories": sum(1 for rs in per_traj.values() if not any(r["label"] == "hijacked" for r in rs))},
        "trajectory_recall_by_attack_type": {k: {"caught": v[0], "n": v[1], "rate": round(v[0] / v[1], 4)} for k, v in sorted(by_attack.items())},
        "trajectory_flag_rate_by_category": {k: {"flagged": v[0], "n": v[1], "rate": round(v[0] / v[1], 4)} for k, v in sorted(by_cat.items())},
        "rules_fired": dict(sorted(((r["rule"] or "(none)") + (" [hij]" if r["label"] == "hijacked" else " [other]"), 0) for r in rows)),
        "baseline_from_paper": {"attack_recovery": 0.554, "f1": 0.647, "partial_hijacks": 0.082, "delayed_executions": 0.231},
    }
    fired = defaultdict(int)
    for r in rows:
        fired[(r["rule"] or "(none)") + (" [hij]" if r["label"] == "hijacked" else " [other]")] += 1
    summary["rules_fired"] = dict(sorted(fired.items(), key=lambda kv: -kv[1]))
    (OUT / "agentdrift.json").write_text(json.dumps({"summary": summary, "rows": rows}, indent=1))
    print(json.dumps({k: v for k, v in summary.items() if k != "rules_fired"}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
