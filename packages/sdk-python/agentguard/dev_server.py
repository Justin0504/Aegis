"""
agentguard dev — in-process gateway server.

Starts a minimal HTTP server that implements the AEGIS check + trace API,
entirely in Python with zero external dependencies beyond the stdlib.

Usage (from CLI):
    agentguard dev [--port 8080] [--db /tmp/agentguard.db]

Usage (from Python):
    import agentguard
    agentguard.dev()   # blocks until Ctrl-C
    # or non-blocking:
    agentguard.dev(background=True)
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Optional
from uuid import uuid4


# ── Classifier (mirrors TypeScript classifier, stdlib only) ─────────────────

_SQL_INJECT    = re.compile(r"\b(OR|AND)\s+['\"]?\d+['\"]?\s*=|--|;.*DROP|UNION\s+SELECT|'\s*OR\s+'1'\s*=\s*'1", re.I)
_SQL_DESTRUCT  = re.compile(r"\b(DROP|TRUNCATE|ALTER|CREATE\s+TABLE|INSERT\s+INTO|DELETE\s+FROM)\b", re.I)
_PATH_TRAV     = re.compile(r"\.\./|\.\.\\|^~/")
_SENSITIVE     = ["/etc/passwd", "/etc/shadow", "/.ssh/", "/.aws/", "/.env", "/proc/"]
_SHELL_META    = re.compile(r"[;&|`]|\$\(|\|\|")
_PROMPT_INJ    = re.compile(r"ignore (previous|above|all)|disregard|you are now|act as if|new instructions", re.I)
_SQL_CONTENT   = re.compile(r"\b(select|insert|update|delete|drop|create table|alter table)\b", re.I)
_URL_CONTENT   = re.compile(r"^https?://", re.I)
_HTTP_PLAIN    = re.compile(r"^http://", re.I)
_PATH_CONTENT  = re.compile(r"^/[a-z]|^[a-z]:\\", re.I)

_NAME_KEYWORDS = [
    (["sql", "query", "database", "db_", "_db", "sqlite", "postgres", "mysql",
      "execute", "select", "insert", "update", "delete_row", "run_query", "exec_query"], "database"),
    (["file", "read_", "write_", "open_", "path", "dir", "folder",
      "ls_", "list_", "mkdir", "rm_", "delete_file", "move_file", "copy_file", "glob"], "file"),
    (["http", "request", "fetch", "url", "api_call", "api_get", "api_post",
      "webhook", "get_url", "post_url", "download", "upload", "curl", "web_search", "browse", "scrape"], "network"),
    (["shell", "exec", "bash", "cmd", "command", "run_", "subprocess",
      "terminal", "powershell", "spawn", "popen"], "shell"),
    (["email", "send_", "mail", "slack", "notify", "message", "sms",
      "telegram", "discord", "push_notification", "alert_"], "communication"),
]

_CATEGORY_RISK = {
    "database": "HIGH", "file": "MEDIUM", "network": "MEDIUM",
    "shell": "CRITICAL", "communication": "MEDIUM",
    "data": "LOW", "unknown": "LOW",
}


def _extract_strings(obj, depth=0):
    if depth > 8:
        return []
    if isinstance(obj, str):
        return [obj]
    if isinstance(obj, list):
        return [s for item in obj for s in _extract_strings(item, depth + 1)]
    if isinstance(obj, dict):
        return [s for v in obj.values() for s in _extract_strings(v, depth + 1)]
    return []


def classify(tool_name: str, args: dict, overrides: dict) -> dict:
    if tool_name in overrides:
        return {"category": overrides[tool_name], "source": "override", "risks": [], "signals": ["user-override"]}

    vals   = _extract_strings(args)
    joined = "\n".join(vals).lower()
    risks  = []
    signals = []

    for v in vals:
        if _SQL_INJECT.search(v):
            risks.append({"type": "sql_injection", "severity": "HIGH", "detail": f'SQL injection in: "{v[:60]}"'})
            signals.append("sql_injection:HIGH")
        elif _SQL_DESTRUCT.search(v):
            risks.append({"type": "sql_injection", "severity": "MEDIUM", "detail": f'Destructive SQL in: "{v[:60]}"'})
            signals.append("sql_injection:MEDIUM")
        if _PATH_TRAV.search(v):
            risks.append({"type": "path_traversal", "severity": "HIGH", "detail": f'Path traversal in: "{v[:60]}"'})
            signals.append("path_traversal:HIGH")
        for s in _SENSITIVE:
            if s in v:
                risks.append({"type": "sensitive_file", "severity": "CRITICAL", "detail": f"Sensitive path: {s}"})
                signals.append("sensitive_file:CRITICAL")
                break
        if _SHELL_META.search(v):
            risks.append({"type": "shell_injection", "severity": "HIGH", "detail": f'Shell metachar in: "{v[:60]}"'})
            signals.append("shell_injection:HIGH")
        if _HTTP_PLAIN.search(v):
            risks.append({"type": "plaintext_url", "severity": "LOW", "detail": f'Plaintext HTTP: "{v[:80]}"'})
            signals.append("plaintext_url:LOW")
        if _PROMPT_INJ.search(v):
            risks.append({"type": "prompt_injection", "severity": "CRITICAL", "detail": f'Prompt injection: "{v[:80]}"'})
            signals.append("prompt_injection:CRITICAL")

    if json.dumps(args).__len__() > 50_000:
        risks.append({"type": "large_payload", "severity": "MEDIUM", "detail": "Large payload"})

    # content category
    if _SQL_CONTENT.search(joined):
        return {"category": "database", "source": "content", "risks": risks, "signals": signals}
    if any(_URL_CONTENT.search(v) for v in vals):
        return {"category": "network", "source": "content", "risks": risks, "signals": signals}
    if any(_PATH_CONTENT.search(v) for v in vals):
        return {"category": "file", "source": "content", "risks": risks, "signals": signals}
    if _SHELL_META.search(joined):
        return {"category": "shell", "source": "content", "risks": risks, "signals": signals}

    lower = tool_name.lower()
    for keywords, category in _NAME_KEYWORDS:
        if any(kw in lower for kw in keywords):
            signals.append(f"name:{category}")
            return {"category": category, "source": "name", "risks": risks, "signals": signals}

    return {"category": "unknown", "source": "fallback", "risks": risks, "signals": signals}


_SEV_ORDER = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}


def decide(classification: dict) -> tuple[str, str, list[str]]:
    """Returns (decision, risk_level, violations)."""
    risks     = classification.get("risks", [])
    category  = classification.get("category", "unknown")
    base_risk = _CATEGORY_RISK.get(category, "LOW")
    violations = []

    max_sev = _SEV_ORDER.get(base_risk, 0)
    for r in risks:
        sev = r.get("severity", "LOW")
        if _SEV_ORDER.get(sev, 0) > max_sev:
            max_sev = _SEV_ORDER[sev]
        violations.append(r.get("detail", ""))

    sev_name = ["LOW", "MEDIUM", "HIGH", "CRITICAL"][max_sev]

    # Block on HIGH/CRITICAL content risks
    if violations and max_sev >= 2:
        return "block", sev_name, violations

    return "allow", sev_name, []


# ── In-memory/SQLite store ──────────────────────────────────────────────────

class Store:
    def __init__(self, db_path: str = ":memory:"):
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        self._init()

    def _init(self):
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS pending_checks (
                check_id   TEXT PRIMARY KEY,
                agent_id   TEXT NOT NULL,
                tool_name  TEXT NOT NULL,
                arguments  TEXT NOT NULL,
                category   TEXT NOT NULL,
                risk_level TEXT NOT NULL,
                signals    TEXT,
                violations TEXT,
                decision   TEXT NOT NULL DEFAULT 'pending',
                decided_by TEXT,
                decided_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS traces (
                trace_id   TEXT PRIMARY KEY,
                agent_id   TEXT,
                tool_name  TEXT,
                arguments  TEXT,
                result     TEXT,
                risk_level TEXT,
                category   TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        """)
        self.conn.commit()

    def insert_pending(self, row: dict):
        with self.lock:
            self.conn.execute("""
                INSERT INTO pending_checks
                (check_id, agent_id, tool_name, arguments, category, risk_level, signals, violations, expires_at)
                VALUES (:check_id,:agent_id,:tool_name,:arguments,:category,:risk_level,:signals,:violations,:expires_at)
            """, row)
            self.conn.commit()

    def get_pending_list(self, agent_id: str | None = None):
        q = "SELECT * FROM pending_checks WHERE decision='pending' AND expires_at > datetime('now')"
        p = []
        if agent_id:
            q += " AND agent_id=?"
            p.append(agent_id)
        q += " ORDER BY created_at DESC LIMIT 100"
        with self.lock:
            rows = self.conn.execute(q, p).fetchall()
        return [dict(r) for r in rows]

    def get_decision(self, check_id: str):
        with self.lock:
            row = self.conn.execute(
                "SELECT decision, risk_level, decided_by, expires_at FROM pending_checks WHERE check_id=?",
                (check_id,)
            ).fetchone()
        return dict(row) if row else None

    def update_decision(self, check_id: str, decision: str, decided_by: str) -> int:
        with self.lock:
            cur = self.conn.execute("""
                UPDATE pending_checks SET decision=?, decided_by=?, decided_at=datetime('now')
                WHERE check_id=? AND decision='pending'
            """, (decision, decided_by, check_id))
            self.conn.commit()
            return cur.rowcount


# ── HTTP handler ─────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    store: Store  # set by factory

    def log_message(self, fmt, *args):
        pass  # silence default logging

    def _body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def _json(self, data: dict, status: int = 200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = self.path.split("?")[0].rstrip("/")

        if p == "/health":
            return self._json({"status": "ok", "mode": "dev", "timestamp": datetime.now(timezone.utc).isoformat()})

        if p == "/api/v1/check/pending":
            qs    = self.path.split("?")[1] if "?" in self.path else ""
            agent = next((v for k, v in (pair.split("=") for pair in qs.split("&") if "=" in pair) if k == "agent_id"), None)
            rows  = self.store.get_pending_list(agent)
            for r in rows:
                r["arguments"] = json.loads(r["arguments"])
                r["signals"]   = json.loads(r["signals"] or "[]")
                r["violations"] = json.loads(r["violations"] or "[]")
            return self._json({"checks": rows, "total": len(rows)})

        m = re.match(r"^/api/v1/check/([^/]+)/decision$", p)
        if m:
            row = self.store.get_decision(m.group(1))
            if not row:
                return self._json({"error": "Not found"}, 404)
            # auto-expire
            if row["decision"] == "pending" and row["expires_at"] < datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"):
                self.store.update_decision(m.group(1), "block", "timeout")
                return self._json({"decision": "block", "reason": "Timed out"})
            return self._json({"decision": row["decision"], "risk_level": row["risk_level"], "decided_by": row["decided_by"]})

        if p == "/api/v1/traces":
            return self._json({"traces": [], "total": 0})

        self._json({"error": "Not found"}, 404)

    def do_POST(self):
        p = self.path.rstrip("/")

        if p == "/api/v1/check":
            body       = self._body()
            tool_name  = body.get("tool_name", "unknown")
            arguments  = body.get("arguments", {})
            blocking   = body.get("blocking", False)
            overrides  = body.get("user_category_overrides", {})
            agent_id   = body.get("agent_id", "unknown")

            cl         = classify(tool_name, arguments, overrides)
            dec, risk, viols = decide(cl)
            check_id   = str(uuid4())

            if blocking and dec == "block" and risk in ("HIGH", "CRITICAL"):
                # Hold for human review
                expires = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
                # +10 min in sqlite datetime string
                self.store.insert_pending({
                    "check_id":  check_id,
                    "agent_id":  agent_id,
                    "tool_name": tool_name,
                    "arguments": json.dumps(arguments),
                    "category":  cl["category"],
                    "risk_level": risk,
                    "signals":   json.dumps(cl["signals"]),
                    "violations": json.dumps(viols),
                    "expires_at": expires,  # simplified: use actual +10min in prod
                })
                return self._json({
                    "decision": "pending",
                    "check_id": check_id,
                    "risk_level": risk,
                    "category": cl["category"],
                    "reason": viols[0] if viols else "Requires human review",
                })

            return self._json({
                "decision":   dec,
                "check_id":   check_id,
                "risk_level": risk,
                "category":   cl["category"],
                "signals":    cl["signals"],
                "reason":     viols[0] if viols and dec == "block" else None,
            })

        if p == "/api/v1/traces":
            return self._json({"trace_id": str(uuid4()), "status": "ok"})

        self._json({"error": "Not found"}, 404)

    def do_PATCH(self):
        m = re.match(r"^/api/v1/check/([^/]+)$", self.path.rstrip("/"))
        if not m:
            return self._json({"error": "Not found"}, 404)

        body      = self._body()
        decision  = body.get("decision", "")
        if decision not in ("allow", "block"):
            return self._json({"error": "decision must be allow or block"}, 400)

        changed = self.store.update_decision(m.group(1), decision, body.get("decided_by", "dashboard-user"))
        if changed == 0:
            return self._json({"error": "Not found or already decided"}, 404)
        return self._json({"check_id": m.group(1), "decision": decision})


# ── Public API ──────────────────────────────────────────────────────────────

def start(
    port: int = 8080,
    db_path: str = ":memory:",
    background: bool = False,
    quiet: bool = False,
) -> HTTPServer:
    """
    Start the in-process dev gateway.

    Returns the HTTPServer object (useful when background=True).
    Blocks forever when background=False.
    """
    store = Store(db_path)

    def handler_factory(*args, **kwargs):
        h = Handler(*args, **kwargs)
        h.store = store
        return h

    server = HTTPServer(("0.0.0.0", port), handler_factory)

    if not quiet:
        print(f"[AEGIS] Dev gateway on http://localhost:{port}  (in-process, no docker needed)")
        print(f"[AEGIS] Press Ctrl-C to stop")

    if background:
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        return server

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
    return server


def main():
    """CLI entry point: agentguard dev"""
    import argparse
    parser = argparse.ArgumentParser(description="AEGIS dev gateway — zero docker")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--db",   default=":memory:", help="SQLite path (default: in-memory)")
    args = parser.parse_args()
    start(port=args.port, db_path=args.db)


if __name__ == "__main__":
    main()
