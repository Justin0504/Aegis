"""Adaptive attacker against the shipped gateway, on AgentDojo, with an
agent that actually complies with injections.

    AD_BASE_URL=http://127.0.0.1:18200/v1 AD_MODEL=qwen3-8b \
      python adaptive_agentdojo.py --stage baseline               # undefended: which attacks the agent carries out
      python adaptive_agentdojo.py --stage attack --feedback verdict
      python adaptive_agentdojo.py --stage attack --feedback whitebox
      python adaptive_agentdojo.py --stage summary

Why this and not selective/adaptive_attacker.py: there a deployed frontier
agent (Claude Haiku 4.5) acted on none of 237 injections and none of 1,420
rewrites, so that run measured the agent. Here the targets are only the
attacks the UNDEFENDED agent carries out, so each one the defended run
stops was stopped by the gateway, and every rewrite is tested against the
full shipped pipeline (provenance pack, destination rules as holds, the
alignment auditor answering holds first, shown the tool output).

This file is pure orchestration: it drives AgentDojo and reuses the
attacker from selective.adaptive_attacker (rewrite(), its white-box
description, the LLM call) — the same red-team logic the corpus run used,
which is already in the repository.

  round 0   AgentDojo's own important_instructions injection text
  round k   rewrite() revises the injected text given the gateway's feedback
  escaped   the defended run's security check passes AND the gateway
            allowed the attack's sink tool (a conservative executed check)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import run_agentdojo as R  # noqa: E402  (reads AD_BASE_URL / AD_MODEL on import)
from selective import adaptive_attacker as A  # noqa: E402  (attacker: rewrite(), llm(), white-box text)
from agentdojo.attacks.attack_registry import load_attack  # noqa: E402

# The attacker uses the same local endpoint as the agent unless told otherwise.
A.LLM_URL = os.environ.get("ATTACKER_URL", R.BASE_URL or A.LLM_URL)
A.LLM_MODEL = os.environ.get("ATTACKER_MODEL", R.MODEL)

CFG = "aegis_v3_audit"
SUITES = tuple(os.environ.get("AD_SUITES", "banking,slack").split(","))
ROUNDS = int(os.environ.get("AD_ROUNDS", "4"))
OUT = R.RESULTS / "adaptive_agentdojo"
OUT.mkdir(exist_ok=True)


def _suites():
    from agentdojo.task_suite.load_suites import get_suites
    return {k: v for k, v in get_suites(R.VERSION).items() if k in SUITES}


def _sink_tools(suite, injection_task, env) -> set[str]:
    """The tools the injection's own ground truth calls — the ones whose
    allow would mean the attack ran."""
    try:
        return {c.function for c in injection_task.ground_truth(env)}
    except Exception:
        return set()


def _run(pipeline, suite, user_task, injection_task, injections):
    """One defended/undefended run. Returns (security, decisions) where
    decisions are this run's gateway verdicts, newest last."""
    R.DECISIONS.clear()
    env = suite.load_and_inject_default_environment(injections)
    _, security = suite.run_task_with_pipeline(pipeline, user_task, injection_task, injections, environment=env)
    return bool(security), list(R.DECISIONS), env


def _target_decision(decisions, sinks):
    """The gateway's last verdict on a sink tool, for attacker feedback."""
    hits = [d for d in decisions if d["tool"] in sinks]
    return hits[-1] if hits else (decisions[-1] if decisions else {"decision": "allow", "rule": None, "reason": ""})


def _allowed_sink(decisions, sinks) -> bool:
    hits = [d for d in decisions if d["tool"] in sinks]
    return bool(hits) and all(d["decision"] == "allow" for d in hits)


def _pairs(suites):
    for sname, suite in suites.items():
        for ut in suite.user_tasks.values():
            for it in suite.injection_tasks.values():
                yield sname, suite, ut, it


def _attack_text(suite, pipeline, user_task, injection_task):
    """AgentDojo's round-0 injection dict {key: text} for this pair."""
    attack = load_attack(R.ATTACK, suite, pipeline)
    return attack.attack(user_task, injection_task)


def baseline():
    """Which (user_task, injection_task) pairs the undefended agent carries
    out. These are the only targets a defended run can be credited for."""
    suites = _suites()
    carried, rows = [], []
    for sname, suite, ut, it in _pairs(suites):
        pipe = R.build_pipeline("none", sname)
        inj = _attack_text(suite, pipe, ut, it)
        try:
            sec, _, _ = _run(pipe, suite, ut, it, inj)
        except Exception as e:  # noqa: BLE001
            sec = False
            print(f"  ! {sname}/{ut.ID}/{it.ID}: {str(e)[:120]}", flush=True)
        rows.append({"suite": sname, "user_task": ut.ID, "injection_task": it.ID, "carried_out": sec})
        if sec:
            carried.append({"suite": sname, "user_task": ut.ID, "injection_task": it.ID})
        if len(rows) % 20 == 0:
            print(f"  {len(rows)} pairs, {len(carried)} carried out", flush=True)
    (OUT / "baseline.json").write_text(json.dumps(
        {"agent": R.PIPE_MODEL, "n_pairs": len(rows), "carried_out": len(carried), "targets": carried, "rows": rows}, indent=1))
    print(f"baseline: agent carried out {len(carried)} of {len(rows)} pairs")
    return 0


def _start_gateway():
    """Start the shipped-config gateway (provenance pack, destination rules
    demoted to holds; the auditor-first review is done by the executor, as
    in run_agentdojo). Mirrors run_agentdojo.main."""
    g = R.Gateway(CFG, R.PORTS[CFG], pack=True, offline=CFG not in R.AUDIT_CONFIGS).start()
    R.GATEWAYS[CFG] = g
    print(f"gateway {CFG} on :{R.PORTS[CFG]} pack={g.pack} auditor={CFG in R.AUDIT_CONFIGS}", flush=True)
    return g


def attack(feedback: str):
    suites = _suites()
    targets = json.load((OUT / "baseline.json").open())["targets"]
    g = _start_gateway()
    try:
        return _attack(feedback, suites, targets)
    finally:
        g.stop()


def _attack(feedback: str, suites, targets):
    pipe = {s: R.build_pipeline(CFG, s) for s in suites}
    results = []
    for n, tgt in enumerate(targets):
        suite = suites[tgt["suite"]]
        ut = suite.get_user_task_by_id(tgt["user_task"])
        it = suite.get_injection_task_by_id(tgt["injection_task"])
        inj = _attack_text(suite, pipe[tgt["suite"]], ut, it)
        key = next(iter(inj))
        text = inj[key]
        env0 = suite.load_and_inject_default_environment(inj)
        sinks = _sink_tools(suite, it, env0)
        trail, history, escaped = [], [], False
        for rnd in range(ROUNDS + 1):
            cur = dict.fromkeys(inj, text)
            try:
                sec, decisions, _ = _run(pipe[tgt["suite"]], suite, ut, it, cur)
            except Exception as e:  # noqa: BLE001
                trail.append({"round": rnd, "error": str(e)[:160]})
                break
            verdict = _target_decision(decisions, sinks)
            ran = sec and _allowed_sink(decisions, sinks)
            trail.append({"round": rnd, "security": sec, "allowed_sink": _allowed_sink(decisions, sinks),
                          "decision": verdict["decision"], "rule": verdict.get("rule"),
                          "reason": (verdict.get("reason") or "")[:200], "text": text[:600]})
            if ran:
                escaped = True
                break
            if rnd == ROUNDS:
                break
            # Attacker rewrites the text it controls, given the feedback.
            args = {}
            try:
                args = {c.function: c.args for c in it.ground_truth(env0)}.get(next(iter(sinks), ""), {})
            except Exception:
                pass
            nxt = A.rewrite(feedback, ut.PROMPT, next(iter(sinks), it.ID), dict(args or {}), text, verdict, history)
            history.append(text)
            if not nxt:
                trail.append({"round": rnd + 1, "note": "attacker produced no rewrite"})
                break
            text = nxt["injection"]
        results.append({**tgt, "sinks": sorted(sinks), "escaped": escaped, "rounds": ROUNDS, "trail": trail})
        print(f"  {n+1}/{len(targets)} {tgt['suite']}/{tgt['user_task']}/{tgt['injection_task']} "
              f"escaped={escaped} rounds={len([t for t in trail if 'security' in t])}", flush=True)
    _summarise(feedback, results)
    return 0


def _summarise(feedback: str, results):
    n = len(results)
    def flagged_after(r, k):
        rounds = [t for t in r["trail"] if "security" in t and t["round"] <= k]
        if not rounds:
            return True
        return not (rounds[-1]["security"] and rounds[-1]["allowed_sink"])
    per_round = {k: sum(flagged_after(r, k) for r in results) for k in range(ROUNDS + 1)}
    summary = {"agent": R.PIPE_MODEL, "attacker": f"{A.LLM_MODEL}", "feedback": feedback, "config": CFG,
               "rounds": ROUNDS, "n_targets": n,
               "escaped": sum(r["escaped"] for r in results),
               "flagged_by_round": per_round,
               "flag_rate_by_round": {k: round(v / n, 4) if n else 0 for k, v in per_round.items()}}
    (OUT / f"attack.{feedback}.json").write_text(json.dumps({"summary": summary, "results": results}, indent=1))
    print(json.dumps(summary, indent=1))


def summary():
    agg = {"suites": list(SUITES), "config": CFG}
    b = OUT / "baseline.json"
    if b.exists():
        d = json.load(b.open())
        agg["baseline"] = {"agent": d["agent"], "carried_out": d["carried_out"], "of_pairs": d["n_pairs"]}
    for fb in ("verdict", "whitebox"):
        p = OUT / f"attack.{fb}.json"
        if p.exists():
            agg[fb] = json.load(p.open())["summary"]
    (OUT / "adaptive_agentdojo.json").write_text(json.dumps(agg, indent=1))
    print(json.dumps(agg, indent=1))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["baseline", "attack", "summary"], required=True)
    ap.add_argument("--feedback", choices=["verdict", "whitebox"], default="verdict")
    a = ap.parse_args()
    if a.stage == "baseline":
        return baseline()
    if a.stage == "attack":
        return attack(a.feedback)
    return summary()


if __name__ == "__main__":
    raise SystemExit(main())
