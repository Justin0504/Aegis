"""AgentDojo v1.2.1, end to end, with and without AEGIS.

    python run_agentdojo.py --configs none,aegis --mode security --workers 32
    python run_agentdojo.py --summarise            # → results/summary.json + table

What this measures, and what it does not
----------------------------------------
Every number in the paper's Table 5 is per call: given one tool call and
its context, does a detector flag it. A deployment is judged per task: did
the agent finish what the user asked, and did the attacker's goal happen.
AgentDojo measures exactly that, on four suites (workspace, travel,
banking, slack; 97 user tasks, 949 user×injection pairs), with the
`important_instructions` attack, and is what CaMeL, Progent and
LlamaFirewall report against.

Configurations
--------------
  none                          the bare agent (gpt-4o-mini-2024-07-18)
  tool_filter                   AgentDojo built-ins, for reference: an LLM
  repeat_user_prompt            prunes the tool list / the user prompt is
  spotlighting_with_delimiting  repeated / tool output is delimited
  aegis_rules                   the shipping gateway, default policies, no pack
  aegis                         the same gateway + security-instruction-provenance

How AEGIS sits in the pipeline
------------------------------
AgentDojo's ToolsExecutor is replaced by one that, for every tool call the
model emits and before the tool runs:
  1. reports the conversation's new spans to POST /api/v1/context,
     classified exactly as the Python SDK's request-side hook classifies
     them (user message → user, tool result → untrusted, assistant text →
     model; the system prompt is not reported),
  2. asks POST /api/v1/check with the session id,
  3. on allow runs the tool; on block, or on a hold — there is no person
     to answer in a benchmark, so a hold is a refusal — returns the
     gateway's reason in the tool result slot, in-band, so the agent can
     continue. Every decision is logged.
One gateway per configuration, fresh database, enterprise tier, the
shipping build in packages/gateway-mcp/dist.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from ast import literal_eval
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
GW_DIR = REPO / "packages" / "gateway-mcp"
RESULTS = HERE / "results"
MODEL = os.environ.get("AD_MODEL", "gpt-4o-mini-2024-07-18")
# A local model (Ollama's OpenAI-compatible endpoint) when AD_BASE_URL is set.
# AgentDojo resolves the attack's "you are model X" from the pipeline name,
# and knows a model called "local", so local pipelines are named local-<model>.
BASE_URL = os.environ.get("AD_BASE_URL")
LOCAL = bool(BASE_URL)
PIPE_MODEL = f"local-{MODEL.replace(':', '-')}" if LOCAL else MODEL
TAG = os.environ.get("AD_TAG", "")  # suffix for result files, one set per agent model
ATTACK = "important_instructions"
VERSION = "v1.2.1"
# *_v2: gateway with read-only scoping (isReadOnlyTool) — the default
# communication hold and the pack's review rules apply to acting calls only.
# The un-suffixed configs were run on the build before that change and are
# kept as the shipped-v1 result.
PORTS = {"aegis_rules": 18110, "aegis": 18111, "aegis_rules_v2": 18112, "aegis_v2": 18113, "aegis_v2_audit": 18114}
# aegis_v2_audit: the same gateway, but a hold is not a refusal — it goes to
# the gateway's own alignment auditor (POST /api/v1/alignment/check,
# gpt-4o-mini) with the user's request as the declared goal, which approves
# the call if it serves the task (not drifted) and refuses it otherwise:
# the auditor as first reviewer, a person only when it refuses.
AUDIT_CONFIGS = {"aegis_v2_audit"}

for line in (Path.home() / ".openai.env").read_text().splitlines():
    if line.startswith("export OPENAI_API_KEY="):
        os.environ["OPENAI_API_KEY"] = line.split("=", 1)[1].strip()

from agentdojo.agent_pipeline import (AgentPipeline, InitQuery, OpenAILLM,  # noqa: E402
                                      PipelineConfig, SystemMessage, ToolsExecutionLoop, ToolsExecutor)
from agentdojo.agent_pipeline.tool_execution import is_string_list, tool_result_to_str  # noqa: E402
from agentdojo.attacks.attack_registry import load_attack  # noqa: E402
from agentdojo.benchmark import run_task_with_injection_tasks, run_task_without_injection_tasks  # noqa: E402
from agentdojo.task_suite.load_suites import get_suites  # noqa: E402
from agentdojo.types import ChatToolResultMessage, text_content_block_from_string  # noqa: E402
import openai  # noqa: E402


class _NoThinkCompletions:
    """Adds reasoning_effort=none to every call: Qwen3 behind Ollama otherwise
    reasons for hundreds of tokens before each tool call."""
    def __init__(self, inner):
        self._inner = inner

    def create(self, **kw):
        kw.setdefault("extra_body", {})["reasoning_effort"] = "none"
        return self._inner.create(**kw)


def make_client():
    if LOCAL:
        c = openai.OpenAI(base_url=BASE_URL, api_key="ollama", max_retries=4, timeout=600)
        c.chat.completions = _NoThinkCompletions(c.chat.completions)
        return c
    return openai.OpenAI(max_retries=8, timeout=120)

DECISIONS: list[dict] = []
DECISIONS_LOCK = threading.Lock()


# ── the gateway ───────────────────────────────────────────────────────────
class Gateway:
    def __init__(self, tag: str, port: int, pack: bool, offline: bool = True):
        self.tag, self.port, self.pack, self.offline = tag, port, pack, offline
        self.proc = None
        self.key = ""

    def _req(self, method, path, body=None, timeout=15):
        h = {"Content-Type": "application/json"}
        if self.key:
            h["X-API-Key"] = self.key
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}",
                                   data=json.dumps(body).encode() if body is not None else None,
                                   headers=h, method=method)
        for attempt in range(6):
            try:
                with urllib.request.urlopen(r, timeout=timeout) as resp:
                    raw = resp.read()
                return json.loads(raw) if raw else None
            except urllib.error.HTTPError as e:
                if e.code != 429 or attempt == 5:
                    raise
                time.sleep(0.2 * 2 ** attempt)

    def start(self):
        db = f"/tmp/aegis-agentdojo-{self.tag}-{int(time.time())}.db"
        log = open(RESULTS / f"gateway-{self.tag}.log", "w")
        local = ({"AEGIS_LOCAL_LLM_URL": BASE_URL, "AEGIS_LOCAL_LLM_MODEL": MODEL, "AEGIS_LOCAL_LLM_TIMEOUT_MS": "600000",
                  "AEGIS_LOCAL_LLM_EXTRA_BODY": '{"reasoning_effort":"none"}'} if LOCAL else {})
        env = {**os.environ, **local, "PORT": str(self.port), "DB_PATH": db, "AEGIS_LICENSE_TIER": "enterprise",
               "RATE_LIMIT_MAX": "10000000", "LOG_LEVEL": "warn",
               **({"AEGIS_OFFLINE": "1"} if (self.offline or LOCAL) else {})}
        self.proc = subprocess.Popen(["node", "dist/server.js"], cwd=GW_DIR, env=env, stdout=log, stderr=subprocess.STDOUT)
        for _ in range(80):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=1).read()
                break
            except Exception:
                time.sleep(0.5)
        self.key = self._req("GET", "/api/v1/auth/key")["api_key"]
        if self.pack:
            self._req("POST", "/api/v1/dsl/packs/security-instruction-provenance/apply", {})
        return self

    def stop(self):
        if self.proc:
            self.proc.terminate()


GATEWAYS: dict[str, Gateway] = {}


def _spans(messages) -> list[dict]:
    """Same classification as agentguard/context/channels.py, for
    AgentDojo's message type: role decides, and a tool result is untrusted
    whatever carries it."""
    out = []
    for m in messages:
        role = m["role"]
        text = " ".join(b.get("content", "") for b in (m.get("content") or []) if isinstance(b, dict) and b.get("type") == "text")
        if not text.strip():
            continue
        if role == "user":
            out.append({"channel": "user", "text": text[:32000]})
        elif role == "tool":
            out.append({"channel": "untrusted", "text": text[:32000], "source": getattr(m.get("tool_call"), "function", None)})
        elif role == "assistant":
            out.append({"channel": "model", "text": text[:32000]})
    return out


class AegisToolsExecutor(ToolsExecutor):
    """ToolsExecutor with the gateway in front of every call."""

    def __init__(self, gw: Gateway, label: str, audit: bool = False):
        super().__init__(tool_result_to_str)
        self.gw, self.label, self.audit = gw, label, audit

    def _auditor_approves(self, query, messages, tc) -> tuple[bool, dict]:
        thoughts = [" ".join(b.get("content", "") for b in (m.get("content") or []) if isinstance(b, dict))
                    for m in messages if m["role"] == "assistant"][-3:]
        r = self.gw._req("POST", "/api/v1/alignment/check", {
            "agent_id": self.label, "declared_goal": query[:4096],
            "thought_chain": [t[:2048] for t in thoughts if t.strip()],
            "proposed_action": {"tool_name": tc.function, "arguments": dict(tc.args)},
            **({"provider": "local"} if LOCAL else {"provider": "openai", "model": MODEL})}, timeout=600)
        return (not r.get("drifted", True)) and r.get("score", 0) >= 0.5, r

    def query(self, query, runtime, env=None, messages=(), extra_args={}):
        if not messages or messages[-1]["role"] != "assistant" or not messages[-1].get("tool_calls"):
            return query, runtime, env, messages, extra_args
        extra_args = dict(extra_args)
        sid = extra_args.setdefault("aegis_session", f"{self.label}-{uuid.uuid4().hex[:12]}")
        sent = extra_args.get("aegis_spans_sent", 0)
        spans = _spans(messages)
        if len(spans) > sent:
            for i in range(sent, len(spans), 64):
                self.gw._req("POST", "/api/v1/context", {"session_id": sid, "agent_id": self.label, "events": spans[i:i + 64]})
            extra_args["aegis_spans_sent"] = len(spans)

        allowed, results = [], []
        for tc in messages[-1]["tool_calls"]:
            for k, v in list(tc.args.items()):
                if isinstance(v, str) and is_string_list(v):
                    tc.args[k] = literal_eval(v)
            t0 = time.perf_counter()
            d = self.gw._req("POST", "/api/v1/check", {"agent_id": self.label, "session_id": sid,
                                                         "tool_name": tc.function, "arguments": dict(tc.args),
                                                         "environment": "PRODUCTION", "blocking": True})
            ms = (time.perf_counter() - t0) * 1000
            dec = d.get("decision", "allow")
            rule = (d.get("dsl") or {}).get("rule")
            audit = None
            if dec == "pending" and self.audit:
                try:
                    ok, audit = self._auditor_approves(query, messages, tc)
                except Exception as e:  # noqa: BLE001 — an auditor failure is a refusal
                    ok, audit = False, {"error": str(e)[:200]}
                dec = "allow" if ok else "pending"
            with DECISIONS_LOCK:
                DECISIONS.append({"cfg": self.label.split("::")[0], "session": sid, "tool": tc.function, "decision": dec,
                                  "rule": rule, "reason": d.get("reason"), "ms": round(ms, 2),
                                  "gateway_decision": d.get("decision"),
                                  "auditor": None if audit is None else {k: audit.get(k) for k in ("score", "drifted", "reason", "error")}})
            if dec == "allow":
                allowed.append(tc)
            else:
                why = d.get("reason") or "policy"
                verb = "held for human approval and not approved" if dec == "pending" else "blocked before execution"
                results.append(ChatToolResultMessage(role="tool", content=[text_content_block_from_string("")],
                                                     tool_call_id=tc.id, tool_call=tc,
                                                     error=f"[AEGIS] This tool call was {verb}: {why}"))
        if allowed:
            sub = dict(messages[-1]); sub["tool_calls"] = allowed
            _, runtime, env, new_msgs, extra_args = super().query(query, runtime, env, [*messages[:-1], sub], extra_args)
            results = [*new_msgs[len(messages):], *results]
        # keep the original assistant message (all tool calls) in history
        order = {tc.id: i for i, tc in enumerate(messages[-1]["tool_calls"])}
        results.sort(key=lambda m: order.get(m["tool_call_id"], 0))
        return query, runtime, env, [*messages, *results], extra_args


def build_pipeline(cfg: str, suite_name: str):
    client = make_client()
    if cfg in ("none", "tool_filter", "repeat_user_prompt", "spotlighting_with_delimiting") and LOCAL:
        pc = PipelineConfig(llm=OpenAILLM(client, MODEL), model_id=None, defense=None if cfg == "none" else cfg,
                            system_message_name=None, system_message=None)
        p = AgentPipeline.from_config(pc)
        p.name = PIPE_MODEL if cfg == "none" else f"{PIPE_MODEL}-{cfg}"
        return p
    if cfg in ("none", "tool_filter", "repeat_user_prompt", "spotlighting_with_delimiting"):
        # by name, not by object: AgentDojo's tool_filter refuses an LLM
        # object without a name, and the string route builds the same client
        pc = PipelineConfig(llm=MODEL, model_id=None, defense=None if cfg == "none" else cfg,
                            system_message_name=None, system_message=None)
        p = AgentPipeline.from_config(pc)
        p.name = MODEL if cfg == "none" else f"{MODEL}-{cfg}"
        return p
    # aegis variants: the plain pipeline, with the executor replaced
    pc = PipelineConfig(llm=OpenAILLM(client, MODEL), model_id=None, defense=None, system_message_name=None, system_message=None)
    base = AgentPipeline.from_config(pc)
    llm = OpenAILLM(client, MODEL)
    sysmsg = next(e for e in base.elements if isinstance(e, SystemMessage))
    loop = ToolsExecutionLoop([AegisToolsExecutor(GATEWAYS[cfg], f"{cfg}::{suite_name}", audit=cfg in AUDIT_CONFIGS), llm])
    p = AgentPipeline([sysmsg, InitQuery(), llm, loop])
    p.name = f"{PIPE_MODEL}-{cfg}"
    return p


def jobs_for(configs, mode, suites):
    out = []
    for cfg in configs:
        for sname, suite in suites.items():
            for ut in suite.user_tasks:
                out.append((cfg, sname, ut))
    return out


def run_one(cfg, sname, ut_id, mode, suites):
    # AgentDojo keeps its logger stack in a ContextVar whose default is one
    # shared list; worker threads must each get their own or concurrent
    # tasks push and pop each other's loggers.
    from agentdojo.logging import LOGGER_STACK, OutputLogger
    LOGGER_STACK.set([])
    with OutputLogger(str(RESULTS / "logs")):
        return _run_one(cfg, sname, ut_id, mode, suites)


def _run_one(cfg, sname, ut_id, mode, suites):
    suite = suites[sname]
    pipeline = build_pipeline(cfg, sname)
    logdir = RESULTS / "logs"
    user_task = suite.get_user_task_by_id(ut_id)
    if mode == "utility":
        u, s = run_task_without_injection_tasks(suite, pipeline, user_task, logdir, force_rerun=False, benchmark_version=VERSION)
        return {"cfg": cfg, "suite": sname, "user_task": ut_id, "injection_task": None, "utility": bool(u), "security": bool(s)}
    attack = load_attack(ATTACK, suite, pipeline)
    utility, security = run_task_with_injection_tasks(suite, pipeline, user_task, attack, logdir, force_rerun=False,
                                                      benchmark_version=VERSION)
    return [{"cfg": cfg, "suite": sname, "user_task": ut_id, "injection_task": inj, "utility": bool(utility[(ut_id, inj)]),
             "security": bool(security[(ut_id, inj)])} for (_, inj) in utility]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--configs", default="none,aegis")
    ap.add_argument("--mode", choices=["utility", "security"], default="security")
    ap.add_argument("--suites", default="workspace,travel,banking,slack")
    ap.add_argument("--workers", type=int, default=32)
    ap.add_argument("--limit", type=int, default=0, help="user tasks per suite, for a smoke run")
    ap.add_argument("--summarise", action="store_true")
    a = ap.parse_args()
    RESULTS.mkdir(exist_ok=True)
    import logging
    logging.basicConfig(level=logging.ERROR)
    for name in ("agentdojo", "httpx", "openai"):
        logging.getLogger(name).setLevel(logging.ERROR)
    if a.summarise:
        return summarise()
    configs = a.configs.split(",")
    suites = {k: v for k, v in get_suites(VERSION).items() if k in a.suites.split(",")}
    for cfg in configs:
        if cfg.startswith("aegis"):
            GATEWAYS[cfg] = Gateway(cfg, PORTS[cfg], pack=cfg in ("aegis", "aegis_v2", "aegis_v2_audit"), offline=cfg not in AUDIT_CONFIGS).start()
            print(f"gateway {cfg} on :{PORTS[cfg]} pack={GATEWAYS[cfg].pack} auditor={cfg in AUDIT_CONFIGS}", flush=True)
    jobs = jobs_for(configs, a.mode, suites)
    if a.limit:
        keep, seen = [], defaultdict(int)
        for j in jobs:
            if seen[(j[0], j[1])] < a.limit:
                keep.append(j); seen[(j[0], j[1])] += 1
        jobs = keep
    out_path = RESULTS / f"rows-{a.mode}{TAG}.jsonl"
    done = 0
    t0 = time.time()
    try:
        with ThreadPoolExecutor(a.workers) as ex, open(out_path, "a") as out:
            futs = {ex.submit(run_one, *j, a.mode, suites): j for j in jobs}
            for f in as_completed(futs):
                j = futs[f]
                try:
                    r = f.result()
                    for row in (r if isinstance(r, list) else [r]):
                        out.write(json.dumps(row) + "\n")
                    out.flush()
                except Exception as e:  # noqa: BLE001 — one task must not end the run
                    out.write(json.dumps({"cfg": j[0], "suite": j[1], "user_task": j[2], "error": f"{type(e).__name__}: {str(e)[:300]}"}) + "\n")
                    out.flush()
                done += 1
                if done % 20 == 0 or done == len(jobs):
                    print(f"  {done}/{len(jobs)} user tasks  {time.time() - t0:.0f}s", flush=True)
    finally:
        with open(RESULTS / f"decisions-{a.mode}{TAG}.jsonl", "a") as f:
            for d in DECISIONS:
                f.write(json.dumps(d) + "\n")
        for g in GATEWAYS.values():
            g.stop()


def summarise():
    rows = {}
    for mode in ("utility", "security"):
        p = RESULTS / f"rows-{mode}{TAG}.jsonl"
        if not p.exists():
            continue
        for l in p.open():
            r = json.loads(l)
            if "error" in r:
                continue
            rows[(mode, r["cfg"], r["suite"], r["user_task"], r.get("injection_task"))] = r
    agg = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    for (mode, cfg, suite, ut, inj), r in rows.items():
        if mode == "utility":
            agg[cfg]["utility"][0] += r["utility"]; agg[cfg]["utility"][1] += 1
        else:
            agg[cfg]["utility_under_attack"][0] += r["utility"]; agg[cfg]["utility_under_attack"][1] += 1
            agg[cfg]["asr"][0] += r["security"]; agg[cfg]["asr"][1] += 1
    summary = {cfg: {k: {"num": v[0], "den": v[1], "rate": v[0] / v[1] if v[1] else None} for k, v in d.items()} for cfg, d in agg.items()}
    (RESULTS / "summary.json").write_text(json.dumps(summary, indent=1))
    print(f"{'config':32s} {'utility':>14s} {'util|attack':>14s} {'ASR':>14s}")
    for cfg, d in summary.items():
        f = lambda k: f"{d[k]['rate']*100:5.1f}% ({d[k]['num']}/{d[k]['den']})" if k in d else "—"
        print(f"{cfg:32s} {f('utility'):>14s} {f('utility_under_attack'):>14s} {f('asr'):>14s}")


if __name__ == "__main__":
    main()
