"""A minimal MCP server exposing the three compat tools, for the MCP-proxy row.

Run by the AEGIS MCP proxy as its upstream:
    python -m agentguard.mcp_proxy --server python mcp_server.py --gateway <url> --agent-id compat-mcp
"""
from mcp.server.fastmcp import FastMCP

from common import execute_tool

mcp = FastMCP("compat-tools")


@mcp.tool()
def query_database(sql: str) -> str:
    """Run a SQL query against the company database."""
    return execute_tool("query_database", {"sql": sql})


@mcp.tool()
def run_shell(command: str) -> str:
    """Run a shell command on the ops host."""
    return execute_tool("run_shell", {"command": command})


@mcp.tool()
def read_file(path: str) -> str:
    """Read a text file from the scratch filesystem."""
    return execute_tool("read_file", {"path": path})


if __name__ == "__main__":
    mcp.run(transport="stdio")
