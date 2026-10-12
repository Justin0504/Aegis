"""AEGIS for the Claude Agent SDK (Claude Code runtime).

The Claude Agent SDK does not expose a client to patch: the model loop and
the tools (Bash, Edit, WebFetch, MCP tools) run inside Claude Code. What it
does expose is a PreToolUse hook that fires before every tool call and can
deny it with a reason the model sees. That is exactly the interposition
point AEGIS wants, so this module turns the gateway check into that hook:

    from claude_agent_sdk import ClaudeAgentOptions, HookMatcher, query
    from agentguard.integrations.claude_agent_sdk import aegis_hook

    options = ClaudeAgentOptions(
        hooks={"PreToolUse": [HookMatcher(hooks=[aegis_hook("http://localhost:8080", "my-agent")])]},
    )
    async for msg in query(prompt="...", options=options): ...

A `block` becomes a permission denial carrying the gateway's reason; a
`pending` call is held until a person decides in the Cockpit (or until
`human_approval_timeout_s`), then allowed or denied accordingly.
"""
from __future__ import annotations

import json
import time
import urllib.request
from typing import Any, Awaitable, Callable


def aegis_hook(gateway_url: str, agent_id: str, *, human_approval_timeout_s: float = 300.0,
               poll_interval_s: float = 1.0, api_key: str | None = None,
               fail_open: bool = False) -> Callable[..., Awaitable[dict[str, Any]]]:
    gateway_url = gateway_url.rstrip("/")

    def _req(method: str, path: str, body: dict | None = None) -> dict:
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["X-API-Key"] = api_key
        req = urllib.request.Request(f"{gateway_url}{path}", data=json.dumps(body).encode() if body is not None else None,
                                     headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read() or b"{}")

    def _deny(reason: str) -> dict[str, Any]:
        return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                       "permissionDecisionReason": f"AEGIS blocked this call before execution: {reason}"}}

    async def hook(input_data: dict[str, Any], tool_use_id: str | None, context: Any) -> dict[str, Any]:
        tool = input_data.get("tool_name") or "unknown"
        args = input_data.get("tool_input") or {}
        try:
            d = _req("POST", "/api/v1/check", {"agent_id": agent_id, "tool_name": tool, "arguments": args,
                                               "environment": "PRODUCTION", "blocking": True})
        except Exception as e:  # gateway unreachable
            return {} if fail_open else _deny(f"gateway unreachable ({e})")
        decision = d.get("decision", "allow")
        if decision == "pending":
            deadline = time.time() + human_approval_timeout_s
            while time.time() < deadline:
                time.sleep(poll_interval_s)
                try:
                    r = _req("GET", f"/api/v1/check/{d['check_id']}/decision")
                except Exception:
                    continue
                if r.get("decision") in ("allow", "block"):
                    decision = r["decision"]
                    d["reason"] = r.get("reason") or d.get("reason") or "human decision"
                    break
            else:
                decision, d["reason"] = "block", "approval timed out"
        if decision == "block":
            return _deny(d.get("reason") or "policy violation")
        return {}

    return hook
