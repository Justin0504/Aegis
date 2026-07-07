"""
End-to-end chaos demo for the SDK reliability layer.

Scenario:
  1. Gateway is up. Send 5 traces → all succeed. Print metrics.
  2. Kill the gateway. Send 10 traces → retries exhaust, circuit trips,
     traces persist to disk. Print metrics.
  3. Restart the gateway.
  4. Simulate a fresh process: build a NEW TransportService with
     replay-on-startup enabled. Watch it drain the disk queue.

Uses a temporary local storage path so the demo can't corrupt the
user's real ~/.agentguard/traces directory.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
import types
from pathlib import Path

# Ensure we import the local SDK, not any installed one.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "packages" / "sdk-python"))

from agentguard.core.config import AgentGuardConfig     # noqa: E402
from agentguard.transport.service import TransportService  # noqa: E402


# Route logs to stdout so we see structured events in real time.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-5s  %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)

GATEWAY_URL = "http://localhost:8080"
GATEWAY_DIST = Path("/Users/justin/agentguard/packages/gateway-mcp/dist/server.js")


def hr(title: str) -> None:
    bar = "─" * 60
    print(f"\n{bar}\n▶ {title}\n{bar}")


def make_transport(tmp_path: Path, gateway_url: str = GATEWAY_URL) -> TransportService:
    base_config = AgentGuardConfig(
        agent_id="11111111-2222-3333-4444-555555555555",
        gateway_url=gateway_url,
        enable_async=False,        # sync mode so metrics reflect send calls immediately
        enable_local_fallback=True,
        local_storage_path=tmp_path,
        batch_size=1,
        flush_interval_seconds=0.1,
    )
    # Attach reliability knobs (not yet promoted to pydantic model)
    return TransportService(types.SimpleNamespace(
        **base_config.model_dump(),
        retry_max_attempts=3,
        retry_base_delay=0.2,
        retry_cap_delay=1.5,
        circuit_failure_threshold=3,
        circuit_open_duration=5.0,
        enable_replay_on_startup=True,
        replay_startup_delay=0.5,
        replay_rate=50.0,
    ))


def _make_trace(label: str, i: int) -> dict:
    """Produce a fully-formed trace that passes the gateway's Zod schema.

    Fields covered:
      - UUID trace_id
      - ISO8601 timestamp
      - non-negative sequence_number
      - nested input_context / thought_chain / tool_call / observation
      - SHA256-shaped integrity_hash (64 hex chars)
    """
    import hashlib
    import uuid
    from datetime import datetime, timezone

    ts = datetime.now(timezone.utc).isoformat()
    return {
        "trace_id": str(uuid.uuid4()),
        "agent_id": "11111111-2222-3333-4444-555555555555",
        "timestamp": ts,
        "sequence_number": i,
        "input_context": {
            "prompt": f"chaos demo {label}-{i}",
        },
        "thought_chain": {
            "raw_tokens": "no-op demo",
        },
        "tool_call": {
            "tool_name": "noop",
            "function":  "noop",
            "arguments": {"label": label, "i": i},
            "timestamp": ts,
        },
        "observation": {
            "raw_output":  "ok",
            "duration_ms": 1.0,
        },
        "integrity_hash": hashlib.sha256(f"{label}-{i}".encode()).hexdigest(),
        "environment": "DEVELOPMENT",
        "version": "1.0.0",
    }


def send_batch(svc: TransportService, n: int, label: str) -> None:
    for i in range(n):
        svc.send_trace_dict(_make_trace(label, i))


def print_metrics(svc: TransportService) -> None:
    snap = svc.metrics_snapshot()
    print(json.dumps(snap, indent=2))


def find_gateway_pid() -> int | None:
    try:
        out = subprocess.check_output(
            ["lsof", "-ti:8080", "-sTCP:LISTEN"], text=True,
        )
        pids = [p for p in out.strip().split() if p]
        return int(pids[0]) if pids else None
    except subprocess.CalledProcessError:
        return None


def stop_gateway() -> int | None:
    pid = find_gateway_pid()
    if pid is None:
        print("no gateway on :8080")
        return None
    print(f"killing gateway PID {pid}")
    os.kill(pid, 15)
    # Wait until port is free
    for _ in range(50):
        if find_gateway_pid() is None:
            return pid
        time.sleep(0.1)
    return pid


def start_gateway() -> int:
    print(f"starting gateway from {GATEWAY_DIST}")
    log = open("/tmp/aegis-gateway-demo.log", "w")
    proc = subprocess.Popen(
        ["node", str(GATEWAY_DIST)],
        stdout=log, stderr=subprocess.STDOUT,
        cwd=str(GATEWAY_DIST.parent),
    )
    # Wait for port to come up
    for _ in range(100):
        if find_gateway_pid() is not None:
            print(f"gateway ready (PID {proc.pid})")
            return proc.pid
        time.sleep(0.1)
    raise RuntimeError("gateway did not start")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="aegis-chaos-"))
    print(f"local storage: {tmp}")

    original_pid = find_gateway_pid()
    if original_pid is None:
        print("ERROR: gateway not running on :8080. Start it first.")
        shutil.rmtree(tmp, ignore_errors=True)
        return 1
    print(f"gateway up at PID {original_pid}")

    try:
        # ── STAGE 1: Happy path ─────────────────────────────────────
        hr("STAGE 1 — happy path (send 5 traces, gateway healthy)")
        svc = make_transport(tmp)
        send_batch(svc, 5, "happy")
        print_metrics(svc)
        expected = 5
        actual   = svc.metrics_snapshot()["traces_sent"]
        assert actual == expected, f"expected {expected} sent, got {actual}"

        # ── STAGE 2: Gateway killed mid-flight ──────────────────────
        hr("STAGE 2 — kill gateway, send 10 traces (expect: retries, "
           "circuit trips, disk fills)")
        stop_gateway()
        send_batch(svc, 10, "outage")
        print_metrics(svc)
        snap = svc.metrics_snapshot()
        assert snap["circuit_state"] == "open", "expected circuit to have tripped"
        assert snap["circuit_trips"] >= 1
        assert snap["traces_persisted"] >= 1
        assert snap["disk_backlog"] >= 1
        print(f"\n✓ circuit is open, {snap['disk_backlog']} traces waiting on disk")

        # ── STAGE 3: Restart gateway ────────────────────────────────
        hr("STAGE 3 — restart gateway")
        start_gateway()
        time.sleep(1.0)

        # ── STAGE 4: Fresh SDK instance → startup replay drains disk
        hr("STAGE 4 — fresh SDK instance with replay-on-startup enabled")
        svc.shutdown()
        svc2 = make_transport(tmp)
        # Wait for the replay thread to complete
        if hasattr(svc2, "_replay_thread"):
            svc2._replay_thread.join(timeout=10.0)
        print_metrics(svc2)
        final = svc2.metrics_snapshot()
        assert final["replayed_total"] >= 1, "expected replay to have drained some"
        assert final["disk_backlog"] == 0, f"disk still has {final['disk_backlog']} traces"

        print(f"\n✓ replay drained {final['replayed_total']} traces from disk")
        print(f"✓ disk backlog: {final['disk_backlog']}")
        print(f"✓ circuit state: {final['circuit_state']}")

        svc2.shutdown()

        hr("PASS — end-to-end reliability layer works")
        return 0

    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        print(f"cleaned up {tmp}")


if __name__ == "__main__":
    sys.exit(main())
