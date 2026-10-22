"""
AEGIS MCP Proxy — wraps any MCP server and intercepts all tool calls.

Usage (Claude Desktop / Cursor config):
    {
      "mcpServers": {
        "my-server": {
          "command": "python",
          "args": ["-m", "agentguard.mcp_proxy",
                   "--server", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/",
                   "--gateway", "http://localhost:8080",
                   "--agent-id", "claude-desktop"]
        }
      }
    }

The proxy:
  1. Forwards all MCP messages from the client to the upstream server
  2. Pins the upstream's tool list at the gateway (POST /api/v1/mcp/tools):
     a tool whose description changes after approval, or reads like an
     instruction to the model, is refused until an operator re-pins it
  3. Intercepts tools/call requests → POST /api/v1/check → block/allow
  4. Forwards allowed calls, returns error for blocked calls
  5. Logs all tool calls as AEGIS traces

Requires: pip install agentguard-aegis mcp
"""

from __future__ import annotations

import asyncio
import json
import sys
import urllib.request
import urllib.error
from typing import Any, Optional
from uuid import uuid4


GATEWAY_URL = "http://localhost:8080"
AGENT_ID    = "mcp-proxy"


HUMAN_APPROVAL_TIMEOUT_S = 300.0


def _check_sync(tool_name: str, arguments: dict, gateway_url: str, agent_id: str) -> dict:
    """Synchronous pre-execution check. A `pending` decision is held here —
    the MCP call simply takes longer — until a person decides in the
    Cockpit or the hold times out (then it is a block)."""
    payload = json.dumps({
        "agent_id":  agent_id,
        "tool_name": tool_name,
        "arguments": arguments,
        "blocking":  True,
    }).encode()
    req = urllib.request.Request(
        f"{gateway_url}/api/v1/check",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            d = json.loads(r.read())
    except Exception as e:
        # Fail-open: if gateway unreachable, allow the call
        return {"decision": "allow", "reason": f"gateway-error: {e}"}
    if d.get("decision") == "pending" and d.get("check_id"):
        import time
        d["held"] = True
        deadline = time.time() + HUMAN_APPROVAL_TIMEOUT_S
        while time.time() < deadline:
            time.sleep(1.0)
            try:
                with urllib.request.urlopen(f"{gateway_url}/api/v1/check/{d['check_id']}/decision", timeout=5) as r:
                    v = json.loads(r.read())
            except Exception:
                continue
            if v.get("decision") in ("allow", "block"):
                d["decision"] = v["decision"]
                d["reason"] = v.get("reason") or ("rejected by human reviewer" if v["decision"] == "block" else "approved by " + str(v.get("decided_by", "human")))
                break
        else:
            d["decision"], d["reason"] = "block", "human approval timed out"
    return d


def _report_tools(tools: list, gateway_url: str, agent_id: str, server_id: str) -> dict[str, dict]:
    """Pin the upstream's tool list at the gateway (POST /api/v1/mcp/tools).

    A tool's description enters the model's context, and a server can
    change it after the operator approved it. The gateway hashes name,
    description and schema, pins each tool at first sight, marks a tool
    `changed` when the hash moves and `suspicious` when the description
    reads like an instruction to the model. Returns {tool: {status,
    markers}}; an unreachable gateway returns {} and the proxy proceeds,
    the same fail-open as the check itself."""
    payload = json.dumps({"server_id": server_id, "agent_id": agent_id, "tools": [
        {"name": t.name, "description": t.description or "", "input_schema": getattr(t, "inputSchema", None)}
        for t in tools]}).encode()
    req = urllib.request.Request(f"{gateway_url}/api/v1/mcp/tools", data=payload,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            d = json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        print(f"[AEGIS] tool pinning unavailable ({e}); proceeding without it", file=sys.stderr)
        return {}
    return {t["name"]: t for t in d.get("tools", [])}


def _tool_refusal(name: str, pin: dict | None, on_change: str) -> str | None:
    """Why a call to this tool is refused before the gateway even checks
    the arguments, or None. `on_change` is hold (default) or allow."""
    if not pin or on_change == "allow":
        return None
    if pin.get("status") == "changed":
        return (f"[AEGIS BLOCKED] Tool '{name}' changed after it was approved: its description or schema "
                f"differs from the pinned version. Re-pin it in the AEGIS Cockpit (MCP tools) to allow it again.")
    if pin.get("status") == "suspicious":
        return (f"[AEGIS BLOCKED] Tool '{name}' has a description that reads like an instruction to the model "
                f"({', '.join(pin.get('markers') or [])}). Review and re-pin it in the AEGIS Cockpit to allow it.")
    return None


_INSTRUMENTS: dict = {}


def _instrument(gateway_url: str, agent_id: str):
    """One AgentGuard per (gateway, agent): traces in the gateway's schema,
    the agent's hash chain resumed from the gateway, decisions attached."""
    key = (gateway_url, agent_id)
    if key not in _INSTRUMENTS:
        from .core.config import AgentGuardConfig
        from .core.tracer import AgentGuard
        from .interceptors.auto import AutoInstrument
        # Synchronous sends: the proxy is a short-lived subprocess of its host, and
        # a background batch thread would die with it, trace still queued.
        guard = AgentGuard(AgentGuardConfig(agent_id=agent_id, gateway_url=gateway_url,
                                            enable_signing=False, enable_async=False))
        _INSTRUMENTS[key] = AutoInstrument(guard)
    return _INSTRUMENTS[key]


def _send_trace(tool_name: str, arguments: dict, result: Any, gateway_url: str, agent_id: str,
                decision: Optional[dict] = None, start_time: Optional[float] = None, error: Optional[str] = None):
    """Best-effort trace (fire and forget via thread). Every decision the
    proxy took — allow, block, a hold and how it was resolved — is written
    into the trace, in the same chain as the calls that ran."""
    import threading, time
    t0 = start_time or time.time()

    def _send():
        try:
            inst = _instrument(gateway_url, agent_id)
            if decision:
                if decision.get("held"):
                    inst._note_decision(tool_name, arguments, dict(decision, decision="pending"))
                    inst._resolve_hold(tool_name, decision.get("decision") == "allow", decision.get("reason"))
                else:
                    inst._note_decision(tool_name, arguments, decision)
            inst._send_trace(tool_name=tool_name, input_prompt=tool_name, arguments=arguments,
                             result=result, start_time=t0, error=error)
        except Exception as e:  # noqa: BLE001 — tracing must never break the proxy
            print(f"[AEGIS] mcp-proxy trace failed: {e}", file=sys.stderr)

    # Not a daemon: the interpreter waits for the send before exiting.
    threading.Thread(target=_send, daemon=False).start()


async def proxy(
    upstream_cmd: list[str],
    gateway_url: str = GATEWAY_URL,
    agent_id: str = AGENT_ID,
    server_id: Optional[str] = None,
    on_change: str = "hold",
):
    """
    Start an MCP stdio proxy.
    Reads JSON-RPC from stdin, forwards to upstream, intercepts tool calls.
    """
    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        from mcp.server import Server
        from mcp.server.stdio import stdio_server
        from mcp.types import (
            CallToolResult, TextContent, Tool,
            ListToolsResult, ListToolsRequest, CallToolRequest,
        )
    except ImportError:
        print(
            "[AEGIS] MCP proxy requires the 'mcp' package.\n"
            "  pip install mcp\n",
            file=sys.stderr,
        )
        sys.exit(1)

    server = Server("aegis-mcp-proxy")
    upstream_tools: list[Tool] = []

    # ── Connect to upstream server ─────────────────────────────────────────
    params = StdioServerParameters(
        command=upstream_cmd[0],
        args=upstream_cmd[1:],
    )

    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools_result = await session.list_tools()
            upstream_tools = tools_result.tools
            sid = server_id or " ".join(upstream_cmd)[:200]
            pins = _report_tools(upstream_tools, gateway_url, agent_id, sid)
            refused = [n for n, p in pins.items() if p.get("status") != "pinned"]
            if refused:
                print(f"[AEGIS] {len(refused)} tool(s) refused until re-pinned: {', '.join(refused)}", file=sys.stderr)

            print(
                f"[AEGIS] MCP proxy connected — {len(upstream_tools)} tools from upstream, "
                f"gateway={gateway_url}, agent={agent_id}",
                file=sys.stderr,
            )

            # ── List tools handler ─────────────────────────────────────────
            @server.list_tools()
            async def list_tools() -> list[Tool]:
                # The proxy relays text content; dropping outputSchema keeps
                # strict clients from rejecting results that carry none.
                return [Tool(name=t.name, description=t.description, inputSchema=t.inputSchema)
                        for t in upstream_tools]

            # ── Call tool handler ──────────────────────────────────────────
            @server.call_tool()
            async def call_tool(name: str, arguments: dict) -> list[TextContent]:
                # A changed or suspicious tool is refused before its arguments are
                # looked at: the description that induced the call is the attack.
                refusal = _tool_refusal(name, pins.get(name), on_change)
                if refusal:
                    print(f"[AEGIS] BLOCK {name} — tool pin", file=sys.stderr)
                    _send_trace(name, arguments, None, gateway_url, agent_id,
                                decision={"decision": "block", "reason": refusal, "risk_level": "HIGH"}, error=refusal)
                    raise RuntimeError(refusal)
                # Pre-execution check
                loop   = asyncio.get_event_loop()
                result_check = await loop.run_in_executor(
                    None, _check_sync, name, arguments, gateway_url, agent_id
                )
                decision   = result_check.get("decision", "allow")
                risk_level = result_check.get("risk_level", "LOW")
                reason     = result_check.get("reason", "")
                category   = result_check.get("category", "unknown")

                if decision == "block":
                    msg = (
                        f"[AEGIS BLOCKED] Tool '{name}' was blocked before execution.\n"
                        f"Risk: {risk_level} | Category: {category}\n"
                        f"Reason: {reason}"
                    )
                    print(f"[AEGIS] BLOCK {name} ({risk_level}) — {reason}", file=sys.stderr)
                    _send_trace(name, arguments, None, gateway_url, agent_id, decision=result_check, error=reason)
                    # Raise, so the host receives an MCP tool error (isError) —
                    # the same shape as any failed tool, which hosts already handle.
                    raise RuntimeError(msg)

                if decision == "pending":
                    msg = (
                        f"[AEGIS PENDING] Tool '{name}' is awaiting human approval.\n"
                        f"Check ID: {result_check.get('check_id', '')}\n"
                        f"Open the AEGIS dashboard to approve or reject."
                    )
                    print(f"[AEGIS] PENDING {name} — check dashboard", file=sys.stderr)
                    raise RuntimeError(msg)

                # Forward to upstream
                import time as _time
                t_start = _time.time()
                upstream_result = await session.call_tool(name, arguments)

                # Send trace (fire and forget)
                output_text = " ".join(
                    c.text for c in upstream_result.content
                    if hasattr(c, "text")
                ) if upstream_result.content else ""
                _send_trace(name, arguments, output_text, gateway_url, agent_id,
                            decision=result_check, start_time=t_start)

                return upstream_result.content

            # ── Run as stdio server ────────────────────────────────────────
            try:
                async with stdio_server() as (r, w):
                    await server.run(r, w, server.create_initialization_options())
            finally:
                for inst in _INSTRUMENTS.values():
                    try:
                        inst._guard._transport.shutdown()
                    except Exception:
                        pass


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="AEGIS MCP proxy — intercepts tool calls before execution",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Wrap the filesystem MCP server
  python -m agentguard.mcp_proxy \\
    --server npx -y @modelcontextprotocol/server-filesystem / \\
    --gateway http://localhost:8080 --agent-id claude-desktop

  # Claude Desktop config (claude_desktop_config.json):
  {
    "mcpServers": {
      "aegis-fs": {
        "command": "python",
        "args": ["-m", "agentguard.mcp_proxy",
                 "--server", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/",
                 "--gateway", "http://localhost:8080",
                 "--agent-id", "my-agent"]
      }
    }
  }
        """,
    )
    parser.add_argument("--server",   nargs="+", required=True, help="Upstream MCP server command")
    parser.add_argument("--gateway",  default="http://localhost:8080")
    parser.add_argument("--agent-id", default="mcp-proxy")
    parser.add_argument("--server-id", default=None, help="Stable name for this upstream (default: its command line)")
    parser.add_argument("--on-change", choices=["hold", "allow"], default="hold",
                        help="What to do with a tool whose description changed after it was pinned (default: refuse until re-pinned)")
    args = parser.parse_args()

    asyncio.run(proxy(args.server, args.gateway, args.agent_id, args.server_id, args.on_change))


if __name__ == "__main__":
    main()
