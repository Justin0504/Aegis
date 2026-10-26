"""Numbers and real cases for the figures Codex draws (CODEX-FIGURE-BRIEF.md v3).

    python -m figures_src.figure_data   # → paper-arxiv/figdata/{plots,gallery}.json

Every number a figure prints comes from a file this script writes, and every
value here is read from a result file the paper's tables are generated from.
Nothing is typed by hand. Re-run it after any rerun; a figure that disagrees
with these files is wrong, not the file.

plots.json   — D1 frontier (both agent models), D2 load test, D3 AgentDrift,
               F8b judge reliability bins, plus the exact text of each source path.
gallery.json — every call AEGIS refused in the AgentDojo runs, with the user's
               request, the injected text the agent read, the call, the rule's
               reason and whether the attack still landed; the cases the brief
               names are marked `pick`.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

R = Path(__file__).resolve().parent.parent
OUT = R / "paper-arxiv" / "figdata"
LOGS = R / "agentdojo" / "results" / "logs"


def frac(n, d):
    return {"num": n, "den": d, "pct": round(100 * n / d, 1) if d else None}


def plots():
    g = json.load(open(R / "agentdojo/results/summary.json"))
    q = json.load(open(R / "agentdojo/results/summary-qwen3.json"))
    rs = json.load(open(R / "agentdojo/results/rescore_executed.json"))
    label = {"none": "No defense", "repeat_user_prompt": "Prompt repetition",
             "spotlighting_with_delimiting": "Spotlighting", "tool_filter": "LLM tool filter",
             "aegis_v2": "AEGIS (holds refused)", "aegis_v2_audit": "AEGIS + auditor"}
    gpt = []
    for k, name in label.items():
        v = g[k]
        gpt.append({"config": k, "label": name, "utility": frac(v["u"]["num"], v["u"]["den"]),
                    "util_attack": frac(v["ua"]["num"], v["ua"]["den"]) if v.get("ua", {}).get("den") else None,
                    "asr": frac(v["asr"]["num"], v["asr"]["den"]) if v.get("asr", {}).get("den") else None,
                    "needs_person": v.get("needs_person")})
    qlabel = {"none": "No defense", "aegis_v2_audit": "AEGIS + auditor",
              "aegis_v2_audit_hold": "+ destination rules held", "aegis_v2_audit_obs": "+ auditor sees tool output",
              "aegis_v3_audit": "Shipped gateway", "none_heldout": "No defense (held-out suites)",
              "aegis_v3_audit_heldout": "Shipped gateway (held-out suites)"}
    qwen = []
    for k, name in qlabel.items():
        v = q[k]
        ex = rs.get(f"local-qwen3-8b-{k}") if k != "none" else rs.get("local-qwen3-8b")
        qwen.append({"config": k, "label": name, "utility": frac(*v["utility"]),
                     "util_attack": frac(*v["util_attack"]), "asr": frac(*v["asr"]),
                     "slack_inj5_rescore": ex})

    lt = json.load(open(R / "perf/results/loadtest.json"))
    load = {name: [{k: lv[k] for k in ("concurrency", "rps", "p50_ms", "p95_ms", "p99_ms", "errors")}
                   for lv in body["levels"]] for name, body in lt.items() if isinstance(body, dict) and "levels" in body}

    ad = json.load(open(R / "results/selective/agentdrift.json"))["summary"]
    drift = {"dataset": ad["dataset"], "n_trajectories": ad["n_trajectories"], "n_steps": ad["n_steps"],
             "step": {k: ad["step"][k] for k in ("precision", "recall", "f1")},
             "trajectory": {k: ad["trajectory"][k] for k in ("precision", "recall", "f1")},
             "flag_rate_by_label": ad["step"]["flag_rate_by_label"],
             "recall_by_attack_type": ad["trajectory_recall_by_attack_type"]}

    cal = (R.parent / "docs/CALIBRATION-REPORT-anthropic.md").read_text()
    head = dict(re.findall(r"\| \*?\*?(ECE|MCE)\*?\*? \(overall\) \| ([\d.]+) %", cal))
    acc = re.search(r"\| Accuracy \| ([\d.]+) %", cal).group(1)
    conf = re.search(r"\| Mean confidence \| ([\d.]+) %", cal).group(1)
    overall = cal.split("## Reliability diagram — overall", 1)[1].split("###", 1)[0]
    bins = [{"bin": b, "conf": float(c), "acc": float(a), "n": int(n)}
            for b, c, a, n in re.findall(r"([\d.]+–[\d.]+) \| conf \S+ ([\d.]+) \| acc \S+ ([\d.]+) \| n=(\d+)", overall)]
    cats = [{"category": c, "n": int(n), "acc": float(a), "conf": float(m), "ece": float(e)}
            for c, n, a, m, e in re.findall(r"\| `([\w-]+)` \| (\d+) \| ([\d.]+) % \| ([\d.]+) % \| \*\*([\d.]+) %\*\*", cal)]
    judge = {"judge": "anthropic/claude-haiku-4-5-20251001", "n": 30, "ece_pct": float(head["ECE"]),
             "mce_pct": float(head["MCE"]), "accuracy_pct": float(acc), "mean_conf_pct": float(conf),
             "bins": bins, "by_category": cats}

    return {"_sources": ["agentdojo/results/summary.json", "agentdojo/results/summary-qwen3.json",
                         "agentdojo/results/rescore_executed.json", "perf/results/loadtest.json",
                         "results/selective/agentdrift.json", "../docs/CALIBRATION-REPORT-anthropic.md"],
            "D1_agentdojo_gpt4omini": gpt, "D1_agentdojo_qwen3": qwen, "D2_load": load,
            "D3_agentdrift": drift, "F8b_judge_calibration": judge}


def _text(c):
    if isinstance(c, str):
        return c
    return "".join(p.get("content", "") for p in (c or []) if isinstance(p, dict))


# The two configurations the paper's main results report.
RUNS = ["gpt-4o-mini-2024-07-18-aegis_v2", "local-qwen3-8b-aegis_v3_audit"]


def _case(run, f, d):
    msgs = d.get("messages") or []
    return {"id": f"{run}/{f.relative_to(LOGS / run).with_suffix('')}",
            "model": run.split("-aegis")[0], "config": "aegis" + run.split("-aegis", 1)[1],
            "suite": d["suite_name"], "user_task": d["user_task_id"], "injection_task": d.get("injection_task_id"),
            "user_request": next((_text(m["content"]) for m in msgs if m["role"] == "user"), "").strip(),
            "injected_text": re.sub(r"\s+", " ", next(iter((d.get("injections") or {}).values()), "")).strip()[:600],
            "benign": d.get("injection_task_id") in (None, "none"),
            "attack_succeeded": d.get("security"), "utility": d.get("utility")}


def gallery():
    refused, landed = [], []
    for run in RUNS:
        for f in sorted((LOGS / run).rglob("*.json")):
            d = json.load(open(f))
            base = _case(run, f, d)
            for m in d.get("messages") or []:
                err = m.get("error") or ""
                if m["role"] == "tool" and err.startswith("[AEGIS]"):
                    tc = m.get("tool_call") or {}
                    verb, why = re.match(r"\[AEGIS\] This tool call was (.+?): (.*)", err, re.S).groups()
                    refused.append({**base, "call": {"tool": tc.get("function"), "args": tc.get("args")},
                                    "outcome": verb, "reason": why.strip()})
            if d.get("security") and not base["benign"]:
                calls = [{"tool": tc["function"], "args": tc.get("args")}
                         for m in d["messages"] if m["role"] == "assistant" for tc in (m.get("tool_calls") or [])]
                landed.append({**base, "calls": calls})
    # The brief's picks (CODEX-FIGURE-BRIEF.md §G): first case for each pattern.
    want = [("G1", "banking", "update_scheduled_transaction", False), ("G2", "banking", "send_money", False),
            ("G3", "slack", "send_direct_message", False), ("G4", "slack", "post_webpage", False),
            ("G5", "workspace", "send_email", False), ("G6", "slack", "send_direct_message", False),
            ("G7", "banking", "send_money", True)]
    for gid, s, t, benign in want:
        for c in refused:
            if c["suite"] == s and c["benign"] == benign and (t is None or c["call"]["tool"] == t) and "pick" not in c:
                body = json.dumps(c["call"]["args"])
                # G3 is a phishing link the injection planted; G6 is the honest opposite: the
                # call the user asked for, refused under attack (a false positive).
                if gid == "G3" and "secure-systems" not in body:
                    continue
                if gid == "G6" and ("secure-systems" in body or "Alice" not in body):
                    continue
                c["pick"] = gid
                break
    for c in landed:   # G8: the miss the paper names — same tool the user asked for
        if c["suite"] == "workspace" and c["model"].startswith("gpt-4o-mini"):
            c["pick"] = "G8"
            break
    compat = []
    for gid, f in (("C1", "claude-agent-sdk_S2.json"), ("C2", "openai-agents_S4.json")):
        d = json.load(open(R / "compat/results" / f))
        compat.append({"pick": gid, "harness": d["harness"], "scenario": d["scenario"], "expect": d.get("expect"),
                       "escaped": d.get("escaped"), "decisions": d.get("decisions"),
                       "transcript": (d.get("transcript") or "")[:1500]})
    # Keep every pick, plus up to three examples per (suite, tool, outcome), and the counts.
    from collections import Counter
    counts = Counter((c["suite"], c["call"]["tool"], c["outcome"], c["benign"]) for c in refused)
    seen, kept = Counter(), []
    for c in refused:
        k = (c["suite"], c["call"]["tool"], c["outcome"], c["benign"])
        if c.get("pick") or seen[k] < 3:
            kept.append(c); seen[k] += 1
    return {"counts": [{"suite": a, "tool": b, "outcome": o, "benign": n, "n": v} for (a, b, o, n), v in counts.most_common()],
            "n_refused": len(refused), "refused": kept, "landed": landed, "compat": compat}


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    p, g = plots(), gallery()
    (OUT / "plots.json").write_text(json.dumps(p, indent=1, ensure_ascii=False))
    (OUT / "gallery.json").write_text(json.dumps(g, indent=1, ensure_ascii=False))
    print(f"plots.json: {len(p['D1_agentdojo_gpt4omini'])}+{len(p['D1_agentdojo_qwen3'])} configs, "
          f"{len(p['F8b_judge_calibration']['bins'])} bins; gallery.json: {g['n_refused']} refused calls "
          f"({sum(x['n'] for x in g['counts'] if x['benign'])} on benign tasks), {len(g['landed'])} attacks landed, "
          f"picks {sorted(c['pick'] for c in g['refused'] + g['landed'] + g['compat'] if c.get('pick'))}")
