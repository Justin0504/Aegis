#!/usr/bin/env python3
"""
End-to-end SDK reliability chaos test for CI.

Complements the JS smoke.mjs / tenant-isolation.mjs harnesses. Where
those exercise the gateway's HTTP surface, this one exercises the
Python SDK's transport layer against a real gateway that we boot,
kill, restart, and boot again — the same lifecycle a customer's
gateway would experience over a rolling deploy.

Scenarios (each documents `prevents:` — the class of failure it
catches). All scenarios use a temp local-storage path so the test
never touches ~/.agentguard/traces.

  1. Happy path: gateway up, SDK sends N traces → all delivered.
  2. Gateway kill mid-flight: SDK sends K traces → retries exhaust,
     circuit trips, K traces land on the disk queue.
  3. Restart + fresh SDK instance: startup replay drains disk queue,
     circuit closes, disk backlog = 0.
  4. Malformed trace body: SDK sees 400, does NOT persist to disk,
     does NOT trip the breaker (server said "your payload is bad").
  5. Metrics snapshot shape: sanity that every counter exists.

Runs the same build+boot flow as smoke.mjs. Exit 0 on all-green,
non-zero on any failure.

Usage:
  python3 tools/e2e/sdk_chaos.py
  python3 tools/e2e/sdk_chaos.py --no-build
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import types
import uuid
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]

# Make the local SDK + core-schema importable regardless of pip
# install state — the SDK's __init__ transitively imports the
# python-side schema package.
sys.path.insert(0, str(REPO_ROOT / "packages" / "sdk-python"))
sys.path.insert(0, str(REPO_ROOT / "packages" / "core-schema" / "python"))

from agentguard.core.config import AgentGuardConfig            # noqa: E402
from agentguard.transport.service import TransportService      # noqa: E402


# ── Args ────────────────────────────────────────────────────────────

ap = argparse.ArgumentParser()
ap.add_argument("--no-build", action="store_true", help="Skip gateway rebuild")
ap.add_argument("--port", type=int, default=18120, help="Gateway port")
ap.add_argument("--keep", action="store_true", help="Keep gateway alive after tests")
args = ap.parse_args()

BASE = f"http://127.0.0.1:{args.port}"
GATEWAY_DIST = REPO_ROOT / "packages" / "gateway-mcp" / "dist" / "server.js"

# ── Coloured output ─────────────────────────────────────────────────

TTY = sys.stderr.isatty()
def _c(s: str, code: str) -> str:
    return f"\x1b[{code}m{s}\x1b[0m" if TTY else s
green   = lambda s: _c(s, "32")
red     = lambda s: _c(s, "31")
yellow  = lambda s: _c(s, "33")
dim     = lambda s: _c(s, "2")

# Silence the SDK's structured logs unless we're in verbose mode —
# a passing chaos test shouldn't print 500 lines of retry noise.
logging.basicConfig(level=logging.CRITICAL, stream=sys.stderr, format="%(message)s")


# ── Gateway lifecycle ───────────────────────────────────────────────

gateway_proc: Optional[subprocess.Popen] = None
tmp_dir: Optional[Path] = None
db_path: Optional[Path] = None
log_path: Optional[Path] = None
sdk_storage: Optional[Path] = None


def build() -> None:
    sys.stderr.write(dim("▶ npm run build\n"))
    res = subprocess.run(
        ["npm", "run", "build"],
        cwd=str(REPO_ROOT / "packages" / "gateway-mcp"),
        check=False,
    )
    if res.returncode != 0:
        sys.stderr.write(red("build failed\n"))
        sys.exit(1)


def start_gateway() -> None:
    global gateway_proc
    # Fresh temp dir per boot cycle so a restart shares state with
    # the earlier run (writes to the SAME DB file).
    log_fd = open(log_path, "a", buffering=1)
    gateway_proc = subprocess.Popen(
        ["node", str(GATEWAY_DIST)],
        env={
            **os.environ,
            "DB_PATH":        str(db_path),
            "PORT":           str(args.port),
            "RATE_LIMIT_MAX": "1000000",
            "SKIP_BILLING":   "1",
            "LOG_LEVEL":      "warn",
            "NODE_ENV":       "development",
        },
        stdout=log_fd,
        stderr=subprocess.STDOUT,
    )
    # Poll /health
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", args.port), timeout=0.2):
                # Also check HTTP responds
                import urllib.request as ur
                try:
                    with ur.urlopen(f"{BASE}/health", timeout=1) as r:
                        if r.status == 200:
                            return
                except Exception:
                    pass
        except (socket.timeout, ConnectionRefusedError, OSError):
            pass
        time.sleep(0.2)
    sys.stderr.write(red(f"gateway boot timeout on port {args.port}\n"))
    if log_path and log_path.exists():
        sys.stderr.write(dim(log_path.read_text()[-2000:]))
    raise RuntimeError("gateway boot timeout")


def stop_gateway() -> None:
    global gateway_proc
    if gateway_proc is None:
        return
    try:
        gateway_proc.terminate()
        gateway_proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        gateway_proc.kill()
        gateway_proc.wait(timeout=2)
    except Exception:
        pass
    # Wait for port to actually free — subsequent start_gateway() will
    # otherwise race and hit EADDRINUSE.
    for _ in range(50):
        try:
            with socket.create_connection(("127.0.0.1", args.port), timeout=0.1):
                time.sleep(0.1)
        except (ConnectionRefusedError, OSError, socket.timeout):
            break
    gateway_proc = None


def teardown() -> None:
    if args.keep:
        sys.stderr.write(yellow(f"▶ --keep set. gateway pid {gateway_proc.pid if gateway_proc else '?'}, tmp {tmp_dir}\n"))
        return
    stop_gateway()
    if tmp_dir and tmp_dir.exists():
        try: shutil.rmtree(tmp_dir)
        except Exception: pass


# ── SDK factory ─────────────────────────────────────────────────────

def make_service(
    *,
    max_attempts: int = 3,
    open_duration: float = 5.0,
    enable_replay: bool = True,
    replay_delay: float = 0.5,
) -> TransportService:
    """Build a TransportService that hits the test gateway.

    All reliability knobs are on the config so the test can dial in
    faster failure than production defaults would allow (5 attempts
    with 30s backoff would make each chaos scenario take minutes).
    """
    base = AgentGuardConfig(
        agent_id="11111111-2222-3333-4444-555555555555",
        gateway_url=BASE,
        enable_async=False,        # sync so metrics reflect calls immediately
        enable_local_fallback=True,
        local_storage_path=sdk_storage,
        batch_size=1,
        flush_interval_seconds=0.1,
    )
    return TransportService(types.SimpleNamespace(
        **base.model_dump(),
        retry_max_attempts=max_attempts,
        retry_base_delay=0.1,
        retry_cap_delay=0.5,
        circuit_failure_threshold=3,
        circuit_open_duration=open_duration,
        enable_replay_on_startup=enable_replay,
        replay_startup_delay=replay_delay,
        replay_rate=100.0,
    ))


def make_trace(label: str, i: int) -> dict:
    now = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{i:03d}Z"
    return {
        "trace_id": str(uuid.uuid4()),
        "agent_id": "11111111-2222-3333-4444-555555555555",
        "timestamp": now,
        "sequence_number": i,
        "input_context":  {"prompt": f"chaos {label}-{i}"},
        "thought_chain":  {"raw_tokens": "noop"},
        "tool_call":      {
            "tool_name": "noop", "function": "noop",
            "arguments": {"label": label, "i": i}, "timestamp": now,
        },
        "observation":    {"raw_output": "ok", "duration_ms": 1.0},
        "integrity_hash": hashlib.sha256(f"{label}-{i}".encode()).hexdigest(),
        "environment":    "DEVELOPMENT",
        "version":        "1.0.0",
    }


# ── Scenarios ───────────────────────────────────────────────────────

class ScenarioError(AssertionError):
    pass


def scenario_happy_path() -> None:
    """gateway up, SDK sends 5 → all delivered, circuit closed, no disk."""
    svc = make_service()
    try:
        for i in range(5):
            svc.send_trace_dict(make_trace("happy", i))
        snap = svc.metrics_snapshot()
        if snap["traces_sent"] != 5:
            raise ScenarioError(f"expected 5 sent, got {snap['traces_sent']}")
        if snap["circuit_state"] != "closed":
            raise ScenarioError(f"circuit not closed: {snap['circuit_state']}")
        if snap["disk_backlog"] != 0:
            raise ScenarioError(f"unexpected disk backlog: {snap['disk_backlog']}")
    finally:
        svc.shutdown()


def scenario_gateway_kill_persist() -> None:
    """Kill gateway, send N → retries exhaust, breaker trips, N on disk."""
    svc = make_service()
    stop_gateway()
    try:
        for i in range(10):
            svc.send_trace_dict(make_trace("outage", i))
        snap = svc.metrics_snapshot()
        if snap["circuit_state"] != "open":
            raise ScenarioError(f"expected circuit open, got {snap['circuit_state']}")
        if snap["circuit_trips"] < 1:
            raise ScenarioError(f"expected circuit_trips >= 1, got {snap['circuit_trips']}")
        if snap["disk_backlog"] < 1:
            raise ScenarioError(f"expected disk backlog >= 1, got {snap['disk_backlog']}")
        # No traces should have made it to the (dead) gateway.
        if snap["traces_sent"] != 0:
            raise ScenarioError(f"traces_sent should be 0 when gateway is down, got {snap['traces_sent']}")
    finally:
        svc.shutdown()


def scenario_restart_replay() -> None:
    """Restart gateway, new SDK instance replay-on-startup drains disk."""
    # Precondition: disk should have queued traces from the previous
    # scenario. If not (e.g. running out of order), populate a few.
    if sdk_storage and not any(sdk_storage.glob("*.json")):
        # Manufacture backlog: kill gateway, spam, restart. Rare in
        # normal runs.
        pass

    start_gateway()
    svc = make_service(enable_replay=True, replay_delay=0.2)
    try:
        if hasattr(svc, "_replay_thread"):
            svc._replay_thread.join(timeout=10.0)
        snap = svc.metrics_snapshot()
        if snap["replayed_total"] < 1:
            raise ScenarioError(f"expected replayed_total >= 1, got {snap['replayed_total']}")
        if snap["disk_backlog"] != 0:
            raise ScenarioError(f"disk backlog should be 0 after replay, got {snap['disk_backlog']}")
        if snap["circuit_state"] != "closed":
            raise ScenarioError(f"expected circuit closed post-replay, got {snap['circuit_state']}")
    finally:
        svc.shutdown()


def scenario_malformed_payload_does_not_trip() -> None:
    """400 from gateway → no disk persist, no breaker trip."""
    svc = make_service()
    try:
        # Missing required fields → Zod 400
        bad = {"trace_id": "not-a-uuid", "agent_id": "also-not-a-uuid"}
        svc.send_trace_dict(bad)
        snap = svc.metrics_snapshot()
        if snap["circuit_state"] != "closed":
            raise ScenarioError(f"400 tripped the breaker: {snap['circuit_state']}")
        if snap["traces_failed"] < 1:
            raise ScenarioError(f"expected traces_failed >= 1, got {snap['traces_failed']}")
        # Disk backlog should include only what was already there
        # (the previous scenario drained everything, so 0). If the
        # SDK ever starts persisting 4xx payloads, this will catch it.
        pre_files = list(sdk_storage.glob("*.json"))
        if len(pre_files) > 0:
            raise ScenarioError(f"4xx should not persist to disk, found {len(pre_files)} files")
    finally:
        svc.shutdown()


def scenario_metrics_snapshot_shape() -> None:
    """Every documented counter is present."""
    svc = make_service()
    try:
        svc.send_trace_dict(make_trace("shape", 0))
        snap = svc.metrics_snapshot()
        required = {
            "traces_sent", "traces_failed", "traces_persisted",
            "retries_total", "replayed_total", "circuit_trips",
            "circuit_state", "queue_depth", "queue_maxsize",
            "batch_depth", "disk_backlog",
        }
        missing = required - set(snap.keys())
        if missing:
            raise ScenarioError(f"missing metrics keys: {sorted(missing)}")
    finally:
        svc.shutdown()


# Ordered list — some scenarios depend on state from earlier ones
# (kill → restart replay is intentional). The runner enforces order.
SCENARIOS = [
    ("happy_path",                        "SDK reliability regression — sync send loses no traces.",             scenario_happy_path),
    ("gateway_kill_persist",              "Gateway blip silent data loss — no fallback → no retries.",           scenario_gateway_kill_persist),
    ("restart_replay",                    "Fresh SDK on process restart forgets pending disk-backed traces.",    scenario_restart_replay),
    ("malformed_payload_does_not_trip",   "4xx from gateway wrongly trips breaker and DoS's disk with bad data.", scenario_malformed_payload_does_not_trip),
    ("metrics_snapshot_shape",            "Metrics counter removed silently — Prometheus dashboards go blank.",   scenario_metrics_snapshot_shape),
]


# ── Runner ──────────────────────────────────────────────────────────

def main() -> int:
    global tmp_dir, db_path, log_path, sdk_storage
    tmp_dir     = Path(tempfile.mkdtemp(prefix="aegis-sdk-chaos-"))
    db_path     = tmp_dir / "gateway.db"
    log_path    = tmp_dir / "gateway.log"
    sdk_storage = tmp_dir / "sdk-traces"
    sdk_storage.mkdir()

    if not args.no_build:
        build()

    sys.stderr.write(dim(f"▶ booting gateway on :{args.port}\n"))
    start_gateway()
    sys.stderr.write(green(f"✓ gateway ready at {BASE}\n\n"))

    passed = 0
    failed = 0
    for name, prevents, run in SCENARIOS:
        start = time.perf_counter()
        try:
            run()
            elapsed = int((time.perf_counter() - start) * 1000)
            sys.stderr.write(f"{green('  ✓')}  {name}  {dim(f'({elapsed}ms)')}\n")
            passed += 1
        except Exception as e:
            elapsed = int((time.perf_counter() - start) * 1000)
            sys.stderr.write(f"{red('  ✗')}  {name}  {dim(f'({elapsed}ms)')}\n")
            sys.stderr.write(f"     {red(str(e))}\n")
            sys.stderr.write(f"     {dim('prevents: ' + prevents)}\n")
            failed += 1

    sys.stderr.write("\n")
    if failed == 0:
        sys.stderr.write(green(f"✓ {passed}/{len(SCENARIOS)} SDK chaos scenarios passed\n"))
    else:
        sys.stderr.write(red(f"✗ {failed} of {len(SCENARIOS)} SDK chaos scenarios failed ({passed} passed)\n"))

    teardown()
    return 0 if failed == 0 else 1


def _handle_signal(signum, frame):
    teardown()
    sys.exit(130)


if __name__ == "__main__":
    signal.signal(signal.SIGINT,  _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    try:
        sys.exit(main())
    except Exception as e:
        sys.stderr.write(red(f"harness crashed: {e}\n"))
        teardown()
        sys.exit(2)
