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
  2. Intercepts tools/call requests → POST /api/v1/check → block/allow
  3. Forwards allowed calls, returns error for blocked calls
  4. Logs all tool calls as AEGIS traces

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


def _send_trace(tool_name: str, arguments: dict, result: Any, gateway_url: str, agent_id: str):
    """Best-effort async trace (fire and forget via thread)."""
    import threading, time
    payload = json.dumps({
        "agent_id":  agent_id,
        "tool_name": tool_name,
        "arguments": arguments,
        "result":    str(result)[:2000],
        "timestamp": __import__("datetime").datetime.now(timezone.utc).isoformat(),
    }).encode()

    def _send():
        try:
            req = urllib.request.Request(
                f"{gateway_url}/api/v1/traces",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception:
            pass

    threading.Thread(target=_send, daemon=True).start()


async def proxy(
    upstream_cmd: list[str],
    gateway_url: str = GATEWAY_URL,
    agent_id: str = AGENT_ID,
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
                upstream_result = await session.call_tool(name, arguments)

                # Send trace (fire and forget)
                output_text = " ".join(
                    c.text for c in upstream_result.content
                    if hasattr(c, "text")
                ) if upstream_result.content else ""
                await loop.run_in_executor(
                    None, _send_trace, name, arguments, output_text, gateway_url, agent_id
                )

                return upstream_result.content

            # ── Run as stdio server ────────────────────────────────────────
            async with stdio_server() as (r, w):
                await server.run(r, w, server.create_initialization_options())


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
    args = parser.parse_args()

    asyncio.run(proxy(args.server, args.gateway, args.agent_id))


if __name__ == "__main__":
    main()
