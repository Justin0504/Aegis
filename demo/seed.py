#!/usr/bin/env python3
"""
Seed the AEGIS gateway with realistic demo traces.
Run this against a fresh instance to populate the dashboard with example data.

Usage:
    python demo/seed.py [--gateway http://localhost:8080]
"""

import argparse
import hashlib
import json
import random
import time
import uuid
from datetime import datetime, timedelta

import urllib.request

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

parser = argparse.ArgumentParser()
parser.add_argument("--gateway", default="http://localhost:8080")
args = parser.parse_args()
GATEWAY = args.gateway.rstrip("/")

AGENTS = [
    {"id": str(uuid.uuid4()), "name": "research-bot",    "env": "PRODUCTION"},
    {"id": str(uuid.uuid4()), "name": "data-pipeline",   "env": "PRODUCTION"},
    {"id": str(uuid.uuid4()), "name": "customer-support","env": "STAGING"},
]

TOOLS = [
    ("web_search",    [{"query": "latest AI safety research"}, {"query": "OpenAI GPT-5 release date"}]),
    ("read_file",     [{"path": "/reports/q4-summary.pdf"}, {"path": "/data/users.csv"}]),
    ("execute_sql",   [{"sql": "SELECT * FROM orders WHERE status='pending' LIMIT 50"},
                       {"sql": "SELECT COUNT(*) FROM users WHERE created_at > '2024-01-01'"}]),
    ("send_report",   [{"recipient": "cto@company.com", "subject": "Weekly AI Summary"}]),
    ("http_request",  [{"url": "https://api.stripe.com/v1/charges", "method": "GET"}]),
]

SUSPICIOUS = [
    ("execute_sql",  {"sql": "DROP TABLE users"}, "HIGH"),
    ("read_file",    {"path": "../../etc/passwd"}, "CRITICAL"),
    ("http_request", {"url": "http://internal.server/admin"}, "HIGH"),
    ("execute_sql",  {"sql": "DELETE FROM audit_logs WHERE 1=1"}, "HIGH"),
]

PROMPTS = [
    "Analyze the latest market trends and generate a summary report",
    "Search for recent papers on transformer architecture improvements",
    "Query the database for orders placed in the last 24 hours",
    "Read the Q4 financial report and extract key metrics",
    "Send the weekly performance report to the team",
    "Check the API for any failed payment transactions today",
    "Summarize the customer support tickets from this week",
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def calculate_hash(data: dict) -> str:
    return hashlib.sha256(
        json.dumps(data, sort_keys=True).encode()
    ).hexdigest()


def post(path: str, body: dict) -> dict:
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{GATEWAY}{path}",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e)}


def send_trace(agent: dict, tool_name: str, arguments: dict, result: str,
               prompt: str, duration_ms: float, error: str | None,
               ts_offset_hours: float, prev_hash: str | None,
               sequence: int) -> str:
    trace_id = str(uuid.uuid4())
    ts = (datetime.utcnow() - timedelta(hours=ts_offset_hours)).isoformat() + "Z"

    partial = {
        "trace_id": trace_id,
        "agent_id": agent["id"],
        "sequence_number": sequence,
        "tool_call": {"tool_name": tool_name, "function": tool_name,
                      "arguments": arguments, "timestamp": ts},
        "observation": {"error": error, "duration_ms": max(duration_ms, 0.001)},
        "previous_hash": prev_hash,
    }
    integrity_hash = calculate_hash(partial)

    body = {
        "trace_id": trace_id,
        "agent_id": agent["id"],
        "sequence_number": sequence,
        "timestamp": ts,
        "input_context": {"prompt": prompt},
        "thought_chain": {"raw_tokens": "Demo trace — seeded by seed.py", "parsed_steps": []},
        "tool_call": {"tool_name": tool_name, "function": tool_name,
                      "arguments": arguments, "timestamp": ts},
        "observation": {"raw_output": result, "error": error,
                        "duration_ms": max(duration_ms, 0.001)},
        "integrity_hash": integrity_hash,
        "previous_hash": prev_hash,
        "environment": agent["env"],
        "version": "1.0.0",
    }
    result_resp = post("/api/v1/traces", body)
    if "error" in result_resp and "trace_id" not in result_resp:
        print(f"  ✗ {tool_name}: {result_resp['error']}")
    return integrity_hash


# ---------------------------------------------------------------------------
# Seed
# ---------------------------------------------------------------------------

print(f"\n[seed] Connecting to {GATEWAY} ...")
import urllib.request as _r
try:
    with _r.urlopen(f"{GATEWAY}/health", timeout=5) as r:
        print(f"[seed] Gateway OK — {r.read().decode()[:80]}")
except Exception as e:
    print(f"[seed] ERROR: Cannot reach gateway: {e}")
    exit(1)

total = 0
for agent in AGENTS:
    print(f"\n[seed] Agent: {agent['name']} ({agent['id'][:8]}…)")
    prev_hash = None
    sequence = 0

    # 20–35 normal traces spread over the past 48 hours
    n_normal = random.randint(20, 35)
    for i in range(n_normal):
        tool_name, arg_list = random.choice(TOOLS)
        arguments = random.choice(arg_list)
        prompt = random.choice(PROMPTS)
        ts_offset = random.uniform(0, 48)
        duration = random.uniform(80, 4500)
        error = None if random.random() > 0.1 else "Timeout after 30s"

        result = f"Successfully executed {tool_name}" if not error else ""
        prev_hash = send_trace(agent, tool_name, arguments, result,
                               prompt, duration_ms=duration, error=error,
                               ts_offset_hours=ts_offset, prev_hash=prev_hash, sequence=sequence)
        sequence += 1
        total += 1
        time.sleep(0.05)

    # 2–3 suspicious traces
    n_suspicious = random.randint(2, 3)
    for tool_name, arguments, risk in random.sample(SUSPICIOUS, n_suspicious):
        prev_hash = send_trace(
            agent, tool_name, arguments,
            result="",
            prompt="Automated cleanup task",
            duration_ms=random.uniform(10, 50),
            error=f"Blocked by AEGIS policy ({risk} risk)",
            ts_offset_hours=random.uniform(0, 12),
            prev_hash=prev_hash,
            sequence=sequence,
        )
        sequence += 1
        total += 1
        time.sleep(0.05)

    print(f"  → {sequence} traces sent")

print(f"\n[seed] Done! {total} traces seeded across {len(AGENTS)} agents.")
print(f"[seed] Open the dashboard: http://localhost:3001")
