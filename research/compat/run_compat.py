"""Compatibility matrix runner.

    python run_compat.py                      # every harness × every scenario
    python run_compat.py langgraph crewai     # a subset
    python run_compat.py --scenarios S1,S2    # a subset of scenarios

Starts two fresh gateways from the shipping build (one with the OpenAI
upstream, one with the local Ollama upstream for the egress-proxy row),
installs the one DSL rule the S3 scenario needs, runs an approver thread
that plays the second attendee, then runs each (harness, scenario) in its
own process and collects the JSON records into results/.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
GW = REPO / "packages" / "gateway-mcp"
RESULTS = HERE / "results"
PY = str(HERE / ".venv" / "bin" / "python")

PORTS = {"main": 18080, "ollama": 18081}


def env_keys() -> dict[str, str]:
    env = dict(os.environ)
    seen: set[str] = set()
    for f in [Path.home() / ".anthropic.env", Path.home() / "chronoception" / ".env", Path.home() / "Dynabridge" / "backend" / ".env"]:
        if f.exists():
            for line in f.read_text().splitlines():
                line = line.strip().removeprefix("export ").strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip().strip('"').strip("'")
                    # the first file that defines a key wins, over anything inherited from the shell
                    if k not in seen:
                        env[k] = v; seen.add(k)
    return env


def start_gateway(tag: str, port: int, extra_env: dict[str, str]) -> subprocess.Popen:
    db = f"/tmp/aegis-compat-{tag}-{int(time.time())}.db"
    env = {**os.environ, "PORT": str(port), "DB_PATH": db, "AEGIS_LICENSE_TIER": "enterprise", **extra_env}
    log = open(RESULTS / f"gateway-{tag}.log", "w")
    p = subprocess.Popen(["node", "dist/server.js"], cwd=GW, env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1).read()
            return p
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"gateway {tag} did not come up; see {log.name}")


def gw(port, method, path, body=None, key=None):
    h = {"Content-Type": "application/json"}
    if key:
        h["X-API-Key"] = key
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=10) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def prepare(port: int) -> str:
    from common import DSL_RULES
    key = gw(port, "GET", "/api/v1/auth/key")["api_key"]
    r = gw(port, "PUT", "/api/v1/dsl", DSL_RULES, key)
    # the shipped instruction-provenance pack, merged on top (S4)
    pk = gw(port, "POST", "/api/v1/dsl/packs/security-instruction-provenance/apply", {}, key)
    print(f"  gateway :{port} key {key[:8]}… dsl installed: {str(r)[:80]}; pack rules {pk.get('rule_count')}")
    return key


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    scen = next((a.split("=", 1)[1].split(",") for a in sys.argv[1:] if a.startswith("--scenarios=")), ["S1", "S2", "S3", "S4"])
    from harnesses import HARNESSES
    names = args or (list(HARNESSES) + ["js-anthropic", "go-wrap"])
    RESULTS.mkdir(exist_ok=True)
    env = env_keys()
    procs = {"main": start_gateway("main", PORTS["main"], {}),
             "ollama": start_gateway("ollama", PORTS["ollama"], {"AEGIS_PROXY_OPENAI_UPSTREAM": "http://127.0.0.1:11434"})}
    keys = {k: prepare(p) for k, p in PORTS.items()}

    # the second attendee, for both gateways
    sys.path.insert(0, str(HERE))
    import common
    approvers = []
    for tag, port in PORTS.items():
        common.GATEWAY = f"http://127.0.0.1:{port}"; common.API_KEY = keys[tag]
        a = common.Approver(delay_s=3.0); a.run_gateway = port
        # each Approver reads module globals at call time; give each its own copy
        import types
        a_common = types.SimpleNamespace(GATEWAY=common.GATEWAY, API_KEY=common.API_KEY)
        def _gw(method, path, body=None, timeout=10, _ns=a_common):
            h = {"Content-Type": "application/json", "X-API-Key": _ns.API_KEY}
            req = urllib.request.Request(f"{_ns.GATEWAY}{path}", data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
            return json.loads(raw) if raw else None
        a.gw = _gw
        approvers.append(a)
    # patch Approver.run to use its own gw
    def _run(self):
        while not self._stop.is_set():
            try:
                pend = self.gw("GET", "/api/v1/check/pending") or []
                items = pend.get("checks", pend.get("pending", [])) if isinstance(pend, dict) else pend
                now = time.time()
                for p in items:
                    cid = p.get("check_id")
                    if not cid or not str(p.get("agent_id", "")).startswith(common.AGENT_PREFIX):
                        continue
                    first = self._seen.setdefault(cid, now)
                    if now - first >= self.delay_s:
                        self.gw("PATCH", f"/api/v1/check/{cid}", {"decision": self.decision, "decided_by": "attendee-2"})
                        self.decided.append({"check_id": cid, "tool": p.get("tool_name"), "agent_id": p.get("agent_id"), "held_s": round(now - first, 2)})
                        self._seen.pop(cid, None)
            except Exception as e:  # noqa: BLE001
                self.decided.append({"error": str(e)[:120]})
            time.sleep(0.5)
    common.Approver.run = _run
    for a in approvers:
        a.start()

    # Rows with no request-side context reporting: the Go and JS SDKs, the
    # ten-line manual integration, the Claude Code hook, and the two
    # transports. The provenance layer has no ledger there, so S4 is not
    # run; the table says "no ledger" rather than reporting an allow that
    # would measure the absence of the hook, not the layer.
    NO_LEDGER = {"js-anthropic", "go-wrap", "qwen3-ollama", "claude-agent-sdk", "mcp-proxy",
                 "egress-proxy-openai", "egress-proxy-ollama"}
    records = []
    try:
        for name in names:
            port = PORTS["ollama"] if name == "egress-proxy-ollama" else PORTS["main"]
            for sid in scen:
                t0 = time.time()
                if sid == "S4" and name in NO_LEDGER:
                    rec = {"harness": name, "scenario": sid, "expect": "block", "error": "no ledger", "decisions": []}
                    (RESULTS / f"{name}_{sid}.json").write_text(json.dumps(rec, indent=1))
                    records.append(rec)
                    print(f"{name:22s} {sid}  skipped: no context ledger on this path")
                    continue
                e = {**env, "COMPAT_GATEWAY": f"http://127.0.0.1:{port}", "COMPAT_API_KEY": keys["ollama" if port == PORTS["ollama"] else "main"],
                     "PYTHONPATH": str(HERE), "PYTHONUNBUFFERED": "1"}
                try:
                    if name == "js-anthropic":
                        cmd, cwd = ["node", "agent.cjs", sid], HERE / "js"
                    elif name == "go-wrap":
                        cmd, cwd = [str(HERE / "go" / "compat-go"), sid], HERE / "go"
                    else:
                        cmd, cwd = [PY, str(HERE / "harnesses.py"), name, sid], HERE
                    p = subprocess.run(cmd, cwd=cwd, env=e, capture_output=True, text=True, timeout=400)
                    out = p.stdout
                    if name in ("js-anthropic", "go-wrap"):
                        line = [l for l in out.splitlines() if l.startswith("{")]
                        rec = json.loads(line[-1]) if line else {"harness": name, "scenario": sid, "error": "no result", "stderr": p.stderr[-800:], "stdout": out[-800:]}
                        rec.setdefault("expect", {"S1": "allow", "S2": "block", "S3": "pending", "S4": "block"}[sid])
                        if name == "go-wrap":
                            rec["decisions"] = [{"tool": rec.get("tool"), "decision": rec.get("decision"), "reason": rec.get("reason"), "sdk_roundtrip_ms": rec.get("sdk_roundtrip_ms")}]
                            rec["inband"] = "native" if rec.get("decision") == "block" else "n/a"
                    else:
                        rec = json.loads(out.split("@@RESULT@@", 1)[1]) if "@@RESULT@@" in out else {"harness": name, "scenario": sid, "error": "no result", "stderr": p.stderr[-800:], "stdout": out[-800:]}
                    rec["stderr_tail"] = p.stderr[-600:]
                except subprocess.TimeoutExpired as ex:
                    rec = {"harness": name, "scenario": sid, "error": "timeout", "stdout": (ex.stdout or "")[-500:] if isinstance(ex.stdout, str) else ""}
                rec["elapsed_s"] = round(time.time() - t0, 1)
                records.append(rec)
                (RESULTS / f"{name}_{sid}.json").write_text(json.dumps(rec, indent=1))
                dec = [(d.get("tool"), d.get("decision"), d.get("sdk_roundtrip_ms")) for d in rec.get("decisions", [])]
                print(f"{name:22s} {sid}  expect={rec.get('expect','?'):7s} decisions={dec}  inband={rec.get('inband')}  err={rec.get('error','')[:60]}")
    finally:
        for a in approvers:
            a.stop()
        time.sleep(0.6)
        summary = {"records": records, "approvals": [d for a in approvers for d in a.decided]}
        (RESULTS / "compat_results.json").write_text(json.dumps(summary, indent=1))
        for p in procs.values():
            p.terminate()
    print("approvals:", summary["approvals"])


if __name__ == "__main__":
    main()
