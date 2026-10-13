"""Instruction provenance through the SHIPPING gateway, not the sklearn model.

    python -m selective.provenance_gateway_eval          # → results/selective/provenance_gateway.json

Table 6 of the paper is a logistic regression over the four grounded
features, 5-fold CV. That measures what the features can separate; it
does not measure what a deployment gets. This module measures the latter:

  1. start a fresh gateway from the shipping build (enterprise tier so no
     agent lands in audit-only mode),
  2. apply the shipped `security-instruction-provenance` policy pack and
     nothing else custom,
  3. for every record of the instantiated corpus, report its user turn
     and tool return to /api/v1/context exactly as the SDK's request-side
     hook does, then send the call to /api/v1/check with that session,
  4. read the decision and WHICH rule produced it.

A record counts as flagged by Lp when the matched DSL rule is one of the
pack's `provenance-*` rules, at either `block` or `pending`. The raw
gateway decision is recorded as well, because the default policy also
rejects calls whose arguments lack a `reason` property (the 73.9 % benign
block rate of the L1 row); that is reported separately and not credited
to the provenance layer.

Arms, matching provenance_eval.py: malicious (237) against the 426
single-step benign records of the bench file (the Table 5 arm), against
the two-step benign arm (169, the Table 6 arm, where benign calls also
carry tool-derived arguments), and against both together (595).
Latency is the Python round trip to /check, loopback included, which is
what the SDK pays.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
GW = REPO / "packages" / "gateway-mcp"
sys.path.insert(0, str(ROOT))

from benchmark.schema import BenchRecord                      # noqa: E402
from selective.provenance_eval import context_of              # noqa: E402
from selective.taint_eval import load_records, load_twostep   # noqa: E402

PORT = int(os.environ.get("AEGIS_EVAL_PORT", "18090"))
PACK = "security-instruction-provenance"


def _gw(method: str, path: str, body=None, key: str | None = None, timeout: float = 10):
    h = {"Content-Type": "application/json"}
    if key:
        h["X-API-Key"] = key
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}",
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers=h, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def start_gateway(log_path: Path) -> subprocess.Popen:
    db = f"/tmp/aegis-prov-eval-{int(time.time())}.db"
    env = {**os.environ, "PORT": str(PORT), "DB_PATH": db, "AEGIS_LICENSE_TIER": "enterprise",
           "AEGIS_OFFLINE": "1", "RATE_LIMIT_MAX": "1000000"}
    log = open(log_path, "w")
    p = subprocess.Popen(["node", "dist/server.js"], cwd=GW, env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=1).read()
            return p
        except Exception:
            time.sleep(0.5)
    p.kill()
    raise RuntimeError(f"gateway did not come up; see {log_path}")


def check_one(rec: BenchRecord, key: str, agent_id: str) -> dict:
    ctx = context_of(rec)
    sid = f"bench::{rec.id}"
    events = []
    if ctx.user_text.strip():
        events.append({"channel": "user", "text": ctx.user_text[:32_000], "source": "benchmark"})
    if ctx.obs_text.strip():
        events.append({"channel": "untrusted", "text": ctx.obs_text[:32_000], "source": "tool_result"})
    if events:
        _gw("POST", "/api/v1/context", {"session_id": sid, "agent_id": agent_id, "events": events}, key)
    payload = {"agent_id": agent_id, "session_id": sid,
               "tool_name": rec.tool_call.tool_name,
               "arguments": rec.tool_call.arguments or {},
               "framework": rec.tool_call.framework or "benchmark"}
    t0 = time.perf_counter()
    for attempt in range(8):
        try:
            body = _gw("POST", "/api/v1/check", payload, key)
            break
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 7:
                raise
            time.sleep(0.25 * (2 ** attempt))
            t0 = time.perf_counter()
    ms = (time.perf_counter() - t0) * 1000
    dsl = body.get("dsl") or {}
    rule = dsl.get("rule") or ""
    return {"id": rec.id, "label": str(rec.label), "tool": rec.tool_call.tool_name,
            "gateway_decision": body.get("decision"), "gateway_reason": body.get("reason"),
            "dsl_decision": dsl.get("decision"), "dsl_rule": rule,
            "provenance_flag": rule.startswith("provenance-"),
            "provenance_block": rule.startswith("provenance-") and dsl.get("decision") == "block",
            "latency_ms": ms}


def summarise(rows: list[dict], mal_ids: set[str], ben_ids: set[str], field: str) -> dict:
    mal = [r for r in rows if r["id"] in mal_ids]
    ben = [r for r in rows if r["id"] in ben_ids]
    tp = sum(r[field] for r in mal)
    fp = sum(r[field] for r in ben)
    recall = tp / len(mal) if mal else 0.0
    fpr = fp / len(ben) if ben else 0.0
    return {"n_mal": len(mal), "n_ben": len(ben), "tp": tp, "fp": fp,
            "recall": recall, "fpr": fpr, "balanced_accuracy": 0.5 * (recall + (1 - fpr))}


def main() -> int:
    recs = load_records()
    mal = [r for r in recs if r.label == "malicious"]
    ben1 = [r for r in recs if r.label == "benign"]
    ben2 = load_twostep()
    allrecs = mal + ben1 + ben2
    print(f"corpus: {len(mal)} malicious, {len(ben1)} single-step benign, {len(ben2)} two-step benign")

    out_dir = ROOT / "results" / "selective"
    out_dir.mkdir(parents=True, exist_ok=True)
    gw = start_gateway(out_dir / "provenance_gateway.log")
    try:
        key = _gw("GET", "/api/v1/auth/key")["api_key"]
        applied = _gw("POST", f"/api/v1/dsl/packs/{PACK}/apply", {}, key)
        print(f"gateway :{PORT}  pack applied: {applied}")
        # one agent for the whole run, as aegis_rules_http.py does
        agent_id = "aegis-bench-provenance"
        rows = []
        t0 = time.time()
        for i, rec in enumerate(allrecs):
            rows.append(check_one(rec, key, agent_id))
            if (i + 1) % 100 == 0:
                print(f"  {i + 1}/{len(allrecs)}  {time.time() - t0:.1f}s")
    finally:
        gw.terminate()
        try:
            gw.wait(timeout=5)
        except Exception:
            gw.kill()

    mal_ids = {r.id for r in mal}
    ben1_ids = {r.id for r in ben1}
    ben2_ids = {r.id for r in ben2}
    ben_all = ben1_ids | ben2_ids
    lat = sorted(r["latency_ms"] for r in rows)
    p50 = lat[len(lat) // 2]
    summary = {
        "pack": PACK,
        "gateway_build": str(GW / "dist" / "server.js"),
        "latency_p50_ms": p50,
        "latency_p95_ms": lat[int(len(lat) * 0.95)],
        "flag_vs_singlestep": summarise(rows, mal_ids, ben1_ids, "provenance_flag"),
        "flag_vs_twostep": summarise(rows, mal_ids, ben2_ids, "provenance_flag"),
        "flag_vs_all_benign": summarise(rows, mal_ids, ben_all, "provenance_flag"),
        "block_vs_singlestep": summarise(rows, mal_ids, ben1_ids, "provenance_block"),
        "block_vs_twostep": summarise(rows, mal_ids, ben2_ids, "provenance_block"),
        "block_vs_all_benign": summarise(rows, mal_ids, ben_all, "provenance_block"),
        "raw_gateway_nonallow_vs_singlestep": None,
        "rules_fired": {},
    }
    for r in rows:
        r["gw_nonallow"] = r["gateway_decision"] != "allow"
    summary["raw_gateway_nonallow_vs_singlestep"] = summarise(rows, mal_ids, ben1_ids, "gw_nonallow")
    for r in rows:
        if r["dsl_rule"]:
            k = f'{r["dsl_rule"]} [{"mal" if r["id"] in mal_ids else "ben"}]'
            summary["rules_fired"][k] = summary["rules_fired"].get(k, 0) + 1
    # misses: which malicious tools escape, for the limitation paragraph
    missed = {}
    for r in rows:
        if r["id"] in mal_ids and not r["provenance_flag"]:
            missed[r["tool"]] = missed.get(r["tool"], 0) + 1
    summary["missed_malicious_by_tool"] = dict(sorted(missed.items(), key=lambda kv: -kv[1]))
    fp_tools = {}
    for r in rows:
        if r["id"] in ben_all and r["provenance_flag"]:
            fp_tools[r["tool"]] = fp_tools.get(r["tool"], 0) + 1
    summary["false_positive_by_tool"] = dict(sorted(fp_tools.items(), key=lambda kv: -kv[1]))

    (out_dir / "provenance_gateway.json").write_text(json.dumps({"summary": summary, "rows": rows}, indent=1))
    print("\n" + "=" * 72)
    print("INSTRUCTION PROVENANCE THROUGH THE SHIPPING GATEWAY")
    print("=" * 72)
    for k in ("flag_vs_singlestep", "flag_vs_twostep", "flag_vs_all_benign", "block_vs_singlestep",
              "block_vs_twostep", "raw_gateway_nonallow_vs_singlestep"):
        s = summary[k]
        print(f"  {k:36s} recall {s['recall']*100:5.1f}%  FPR {s['fpr']*100:5.1f}%  bal.acc {s['balanced_accuracy']:.3f}")
    print(f"  latency p50 {p50:.1f} ms  p95 {summary['latency_p95_ms']:.1f} ms")
    print("  rules fired:")
    for k, v in sorted(summary["rules_fired"].items()):
        print(f"    {v:4d}  {k}")
    print("  missed malicious by tool:", summary["missed_malicious_by_tool"])
    print("  false positives by tool:", summary["false_positive_by_tool"])
    print(f"\nwrote {out_dir / 'provenance_gateway.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
