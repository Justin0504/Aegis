"""Replay real AgentDojo transcripts through a gateway, as an SDK would.

    .venv/bin/python replay_agentdojo.py <gateway-url> <api-key> <transcript.json>...

Fills a gateway with real agent runs for the Cockpit screenshots. Nothing
is invented: every user turn, tool call, argument and tool result comes
from an AgentDojo transcript (qwen3:8b agent, research/agentdojo). For each
step the script does what the shipping SDK does on a live agent:

  1. reports new context spans to /api/v1/context (user turn → user,
     tool return → untrusted), under the run's session id;
  2. asks /api/v1/check for the call, blocking, so holds carry evidence;
  3. sends the trace through the SDK's AutoInstrument, so the hash chain,
     decision and session id are exactly what a deployed agent writes.

The gateway decides afresh — decisions are the current build's, not the
transcript's. The tool result recorded is the transcript's; a call the
current gateway refuses is recorded as not run. Holds from the last run
given stay pending, so the approval queue shows them with their evidence;
earlier holds are resolved as refused.
"""
from __future__ import annotations

import json
import sys
import time
import uuid
from pathlib import Path

import httpx
from agentguard import AgentGuard
from agentguard.core.config import AgentGuardConfig
from agentguard.interceptors.auto import AutoInstrument

AGENT = {"banking": "banking-assistant", "slack": "slack-assistant",
         "workspace": "workspace-assistant", "travel": "travel-assistant"}


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    return " ".join(b.get("content", "") for b in content or [] if isinstance(b, dict))


def replay(gw: str, key: str, path: Path, keep_pending: bool) -> dict:
    d = json.loads(path.read_text())
    suite = d["suite_name"]
    sid = f"run-{suite}-{d['user_task_id']}-{d.get('injection_task_id') or 'clean'}-{uuid.uuid4().hex[:6]}"
    agent = AGENT.get(suite, f"{suite}-assistant")
    h = {"x-api-key": key, "content-type": "application/json"}
    guard = AgentGuard(AgentGuardConfig(gateway_url=gw, agent_id=agent, api_key=key, session_id=sid,
                                        enable_signing=False, enable_async=False))
    inst = AutoInstrument(guard)
    client = httpx.Client(timeout=30)
    seq, request, out = 0, "", {"session": sid, "calls": 0, "pending": 0, "block": 0}
    results = {m.get("tool_call_id"): m for m in d["messages"] if m["role"] == "tool"}

    def ctx(channel, text, source=None):
        nonlocal seq
        ev = {"seq": seq, "channel": channel, "text": text[:32000]}
        if source:
            ev["source"] = source
        client.post(f"{gw}/api/v1/context", headers=h, json={"session_id": sid, "agent_id": agent, "events": [ev]})
        seq += 1

    for m in d["messages"]:
        if m["role"] == "user":
            request = text_of(m["content"])
            ctx("user", request)
        elif m["role"] == "assistant" and m.get("tool_calls"):
            for tc in m["tool_calls"]:
                name, args = tc["function"], tc.get("args") or {}
                t0 = time.time()
                r = client.post(f"{gw}/api/v1/check", headers=h, json={
                    "agent_id": agent, "session_id": sid, "tool_name": name, "arguments": args,
                    "environment": "PRODUCTION", "blocking": True}).json()
                dec = r.get("decision", "allow")
                out["calls"] += 1
                res = results.get(tc.get("id"), {})
                ran = dec == "allow" and not (res.get("error") or "").startswith("[AEGIS]")
                result = text_of(res.get("content")) if ran else None
                if dec == "pending":
                    out["pending"] += 1
                    inst._note_decision(name, args, dict(r, decision="pending"))
                    if not keep_pending:
                        inst._resolve_hold(name, False, r.get("reason"))
                        if r.get("check_id"):  # the gateway's hold ends too, as a timeout would end it
                            client.patch(f"{gw}/api/v1/check/{r['check_id']}", headers=h,
                                         json={"decision": "block", "decided_by": "timeout"})
                else:
                    out["block"] += dec == "block"
                    inst._note_decision(name, args, r)
                inst._send_trace(tool_name=name, input_prompt=request, arguments=args, result=result,
                                 start_time=t0, error=None if ran or dec != "allow" else res.get("error"))
                if ran and result:
                    ctx("untrusted", result, source=name)
    client.close()
    return out


def main():
    gw, key, files = sys.argv[1].rstrip("/"), sys.argv[2], [Path(p) for p in sys.argv[3:]]
    for i, f in enumerate(files):
        print(json.dumps({"file": f.name, **replay(gw, key, f, keep_pending=i >= len(files) - 3)}))
        time.sleep(1.1)  # distinct timestamps between runs


if __name__ == "__main__":
    main()
