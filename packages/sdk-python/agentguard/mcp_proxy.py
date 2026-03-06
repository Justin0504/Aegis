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


def _check_sync(tool_name: str, arguments: dict, gateway_url: str, agent_id: str) -> dict:
    """Synchronous pre-execution check."""
    payload = json.dumps({
        "agent_id":  agent_id,
        "tool_name": tool_name,
        "arguments": arguments,
        "blocking":  False,
    }).encode()
    req = urllib.request.Request(
        f"{gateway_url}/api/v1/check",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            return json.loads(r.read())
    except Exception as e:
        # Fail-open: if gateway unreachable, allow the call
        return {"decision": "allow", "reason": f"gateway-error: {e}"}


def _send_trace(tool_name: str, arguments: dict, result: Any, gateway_url: str, agent_id: str):
    """Best-effort async trace (fire and forget via thread)."""
    import threading, time
    payload = json.dumps({
        "agent_id":  agent_id,
        "tool_name": tool_name,
        "arguments": arguments,
        "result":    str(result)[:2000],
        "timestamp": __import__("datetime").datetime.utcnow().isoformat(),
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
                return upstream_tools

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
                    return [TextContent(type="text", text=msg)]

                if decision == "pending":
                    msg = (
                        f"[AEGIS PENDING] Tool '{name}' is awaiting human approval.\n"
                        f"Check ID: {result_check.get('check_id', '')}\n"
                        f"Open the AEGIS dashboard to approve or reject."
                    )
                    print(f"[AEGIS] PENDING {name} — check dashboard", file=sys.stderr)
                    return [TextContent(type="text", text=msg)]

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
