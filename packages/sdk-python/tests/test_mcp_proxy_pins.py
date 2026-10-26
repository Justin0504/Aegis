"""The MCP proxy pins the upstream's tools at the gateway and refuses a
changed or suspicious tool before its arguments are looked at."""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace

from agentguard.mcp_proxy import _report_tools, _tool_refusal, _upstream_env, _listed_tools


def _gateway(reply: dict, require_key: str | None = None):
    """A stand-in gateway. With `require_key`, it answers 401 to a request
    without that x-api-key, as the real one does on /api/v1/mcp/tools."""
    seen = {}

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            seen["path"] = self.path
            seen["key"] = self.headers.get("x-api-key")
            seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            ok = require_key is None or seen["key"] == require_key
            out = json.dumps(reply if ok else {"error": {"code": "AUTH_MISSING"}}).encode()
            self.send_response(200 if ok else 401); self.send_header("Content-Type", "application/json")
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


def test_report_sends_the_tenant_key_from_argument_or_environment(monkeypatch):
    reply = {"tools": [{"name": "t", "status": "pinned", "markers": []}]}
    tool = [SimpleNamespace(name="t", description="", inputSchema=None)]
    monkeypatch.delenv("AGENTGUARD_API_KEY", raising=False)
    srv, url, seen = _gateway(reply, require_key="aegis_k1")
    try:
        monkeypatch.delenv("AEGIS_API_KEY", raising=False)
        assert _report_tools(tool, url, "a", "s", api_key="aegis_k1")["t"]["status"] == "pinned"
        monkeypatch.setenv("AEGIS_API_KEY", "aegis_k1")
        assert _report_tools(tool, url, "a", "s")["t"]["status"] == "pinned"
    finally:
        srv.shutdown()
    assert seen["key"] == "aegis_k1"


def test_a_rejected_key_says_pinning_is_disabled_not_that_the_gateway_is_down(monkeypatch, capsys):
    monkeypatch.delenv("AEGIS_API_KEY", raising=False)
    monkeypatch.delenv("AGENTGUARD_API_KEY", raising=False)
    srv, url, _ = _gateway({}, require_key="aegis_k1")
    try:
        assert _report_tools([SimpleNamespace(name="t", description="", inputSchema=None)], url, "a", "s") == {}
    finally:
        srv.shutdown()
    err = capsys.readouterr().err
    assert "pinning DISABLED" in err and "401" in err and "AEGIS_API_KEY" in err


def test_upstream_gets_the_hosts_environment_but_never_the_tenant_key(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_x")
    monkeypatch.setenv("AEGIS_API_KEY", "aegis_k1")
    monkeypatch.setenv("AGENTGUARD_API_KEY", "aegis_k1")
    env = _upstream_env()
    assert env["GITHUB_TOKEN"] == "ghp_x"
    assert "AEGIS_API_KEY" not in env and "AGENTGUARD_API_KEY" not in env


def test_a_refused_tool_is_withheld_from_the_model_not_only_refused():
    tools = [SimpleNamespace(name=n, description="", inputSchema=None) for n in ("ok", "changed", "odd", "new")]
    pins = {"ok": {"status": "pinned"}, "changed": {"status": "changed"}, "odd": {"status": "suspicious", "markers": []}}
    assert [t.name for t in _listed_tools(tools, pins, "hold")] == ["ok", "new"]
    assert len(_listed_tools(tools, pins, "allow")) == 4
