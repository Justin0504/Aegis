"""The MCP proxy pins the upstream's tools at the gateway and refuses a
changed or suspicious tool before its arguments are looked at."""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace

from agentguard.mcp_proxy import _report_tools, _tool_refusal


def _gateway(reply: dict):
    seen = {}

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            seen["path"] = self.path
            seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            out = json.dumps(reply).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)

        def log_message(self, *a):  # noqa: D401
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_port}", seen


def test_report_sends_name_description_schema_and_returns_status_by_tool():
    srv, url, seen = _gateway({"tools": [{"name": "read_file", "status": "changed", "markers": []}]})
    try:
        tools = [SimpleNamespace(name="read_file", description="Read a file", inputSchema={"type": "object"})]
        pins = _report_tools(tools, url, "desktop", "fs")
    finally:
        srv.shutdown()
    assert seen["path"] == "/api/v1/mcp/tools"
    assert seen["body"]["server_id"] == "fs"
    assert seen["body"]["tools"] == [{"name": "read_file", "description": "Read a file", "input_schema": {"type": "object"}}]
    assert pins["read_file"]["status"] == "changed"


def test_unreachable_gateway_pins_nothing_and_proceeds():
    assert _report_tools([SimpleNamespace(name="t", description="", inputSchema=None)], "http://127.0.0.1:9", "a", "s") == {}


def test_changed_and_suspicious_tools_are_refused_unless_told_otherwise():
    assert _tool_refusal("t", {"status": "pinned"}, "hold") is None
    assert "changed after it was approved" in _tool_refusal("t", {"status": "changed"}, "hold")
    assert "secret-path" in _tool_refusal("t", {"status": "suspicious", "markers": ["secret-path"]}, "hold")
    assert _tool_refusal("t", {"status": "changed"}, "allow") is None
    assert _tool_refusal("t", None, "hold") is None
