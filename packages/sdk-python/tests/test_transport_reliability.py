"""
Chaos tests for TransportService.

Covers the reliability guarantees added in the "industry-parity" pass:

  1. Retries on 5xx / network errors, up to `retry_max_attempts`.
  2. Does NOT retry on 4xx (client errors).
  3. Circuit breaker trips after N consecutive failures.
  4. Circuit breaker half-open probes let one call through, then either
     closes (success) or re-opens (failure).
  5. Failed traces persist to disk with an ordering-preserving filename.
  6. Startup replay drains the disk queue oldest-first.
  7. `metrics_snapshot()` reflects the state machine + counters.

All tests use httpx.MockTransport so no real HTTP/network is involved.
"""
from __future__ import annotations

import json
import time
import types
from pathlib import Path
from typing import List

import httpx
import pytest

from agentguard.core.config import AgentGuardConfig
from agentguard.transport.service import (
    STATE_CLOSED, STATE_OPEN, STATE_HALF_OPEN,
    TransportService,
    RetryPolicy,
    CircuitBreaker,
)


# ── Test harness ────────────────────────────────────────────────────

def make_service(
    tmp_path: Path,
    *,
    responses,                       # list of (status_code, body) OR callable
    async_mode: bool = False,
    max_attempts: int = 3,
    failure_threshold: int = 3,
    enable_replay: bool = False,
    open_duration: float = 30.0,
) -> tuple[TransportService, List[dict]]:
    """Build a TransportService whose HTTP client is a MockTransport
    playing back a scripted response sequence.

    Returns (service, sent_payloads) — sent_payloads is a list the
    tests can inspect to verify batching / retry behaviour."""
    sent: List[dict] = []

    if callable(responses):
        script = responses
    else:
        it = iter(responses)
        def script(request: httpx.Request) -> httpx.Response:
            try:
                status, body = next(it)
            except StopIteration:
                status, body = 500, {"error": "no more scripted responses"}
            try:
                sent.append(json.loads(request.content))
            except Exception:
                sent.append({"__raw__": request.content.decode(errors="replace")})
            return httpx.Response(status, json=body)

    config = AgentGuardConfig(
        agent_id="test-agent",
        gateway_url="http://mock",
        enable_async=async_mode,
        enable_local_fallback=True,
        local_storage_path=tmp_path,
        batch_size=100,
        flush_interval_seconds=0.5,
    )
    # Fields that live on the transport (not the pydantic model) —
    # attach them so getattr() picks them up.
    config = types.SimpleNamespace(
        **config.model_dump(),
        retry_max_attempts=max_attempts,
        retry_base_delay=0.0,       # zero delay in tests — no sleeping
        retry_cap_delay=0.0,
        circuit_failure_threshold=failure_threshold,
        circuit_open_duration=open_duration,
        enable_replay_on_startup=enable_replay,
        replay_startup_delay=0.0,
        replay_rate=1000.0,          # basically instant in tests
    )

    svc = TransportService(config)
    # Replace the pre-built httpx client with our mock so identity
    # headers still come from the real config path but requests are
    # intercepted.
    svc._client = httpx.Client(
        base_url="http://mock",
        transport=httpx.MockTransport(script),
    )
    return svc, sent


def _trace(**overrides) -> dict:
    base = {"trace_id": "t-1", "agent_id": "test-agent", "tool_name": "noop"}
    base.update(overrides)
    return base


# ── Retry policy unit tests ─────────────────────────────────────────

def test_retry_delay_full_jitter_bounded():
    p = RetryPolicy(base_delay=1.0, cap_delay=10.0)
    # For attempt N, upper bound is min(cap, base * 2^N)
    for attempt in range(6):
        d = p.delay_for(attempt)
        assert 0.0 <= d <= min(10.0, 1.0 * (2 ** attempt))


def test_retry_delay_no_jitter():
    p = RetryPolicy(base_delay=1.0, cap_delay=10.0, jitter=False)
    assert p.delay_for(0) == 1.0
    assert p.delay_for(1) == 2.0
    assert p.delay_for(5) == 10.0    # capped


# ── Circuit breaker unit tests ──────────────────────────────────────

def test_circuit_breaker_lifecycle():
    b = CircuitBreaker(failure_threshold=2, open_duration=0.01)
    assert b.allow() is True
    b.record_failure()
    assert b.state == STATE_CLOSED
    b.record_failure()
    assert b.state == STATE_OPEN
    # Immediately after opening, calls are rejected
    assert b.allow() is False
    # After open_duration passes, we move to half-open on the next allow()
    time.sleep(0.02)
    assert b.allow() is True
    assert b.state == STATE_HALF_OPEN
    # A success closes the breaker
    b.record_success()
    assert b.state == STATE_CLOSED
    assert b.consecutive_fails == 0


def test_circuit_breaker_half_open_failure_reopens():
    b = CircuitBreaker(failure_threshold=1, open_duration=0.01)
    b.record_failure()
    assert b.state == STATE_OPEN
    time.sleep(0.02)
    b.allow()   # → half-open
    b.record_failure()   # probe failed
    assert b.state == STATE_OPEN


# ── send_trace: retry on 5xx ────────────────────────────────────────

def test_retries_on_500_then_succeeds(tmp_path):
    svc, sent = make_service(tmp_path, responses=[
        (500, {"err": "boom"}),
        (503, {"err": "boom"}),
        (200, {"ok": True}),
    ], max_attempts=3)
    assert svc.send_trace_dict(_trace()) is True
    assert len(sent) == 3       # two retries then success
    assert svc.metrics_snapshot()["retries_total"] == 2
    assert svc.metrics_snapshot()["traces_sent"] == 1


def test_does_not_retry_on_400(tmp_path):
    svc, sent = make_service(tmp_path, responses=[
        (400, {"err": "bad payload"}),
    ], max_attempts=5)
    assert svc.send_trace_dict(_trace()) is False
    assert len(sent) == 1    # one attempt, no retry
    assert svc.metrics_snapshot()["retries_total"] == 0
    assert svc.metrics_snapshot()["traces_failed"] == 1
    # 4xx means "gateway is UP and rejecting us" — breaker should NOT trip
    assert svc.metrics_snapshot()["circuit_state"] == STATE_CLOSED


def test_retries_on_429(tmp_path):
    """429 is throttling — retryable. Different from other 4xx."""
    svc, sent = make_service(tmp_path, responses=[
        (429, {"err": "slow down"}),
        (200, {"ok": True}),
    ], max_attempts=3)
    assert svc.send_trace_dict(_trace()) is True
    assert len(sent) == 2


# ── Circuit breaker via send loop ───────────────────────────────────

def test_circuit_trips_after_repeated_failures(tmp_path):
    svc, sent = make_service(
        tmp_path,
        responses=[(500, {})] * 100,     # always 500
        max_attempts=1,
        failure_threshold=3,
    )
    # 3 failures should trip the circuit; further calls should short-circuit
    for _ in range(3):
        svc.send_trace_dict(_trace())
    assert svc.metrics_snapshot()["circuit_state"] == STATE_OPEN
    assert svc.metrics_snapshot()["circuit_trips"] == 1

    calls_before = len(sent)
    svc.send_trace_dict(_trace(trace_id="short-circuited"))
    # Circuit is open — no HTTP call, straight to disk
    assert len(sent) == calls_before
    assert svc.metrics_snapshot()["traces_persisted"] >= 1


def test_circuit_recovers_after_open_duration(tmp_path):
    svc, sent = make_service(
        tmp_path,
        responses=[
            (500, {}), (500, {}),    # trip
            (200, {"ok": True}),     # probe succeeds
            (200, {"ok": True}),
        ],
        max_attempts=1,
        failure_threshold=2,
        open_duration=0.01,
    )
    svc.send_trace_dict(_trace())
    svc.send_trace_dict(_trace())
    assert svc.metrics_snapshot()["circuit_state"] == STATE_OPEN
    time.sleep(0.02)
    # This call becomes the probe; on 200 breaker closes
    assert svc.send_trace_dict(_trace(trace_id="probe")) is True
    assert svc.metrics_snapshot()["circuit_state"] == STATE_CLOSED


# ── Disk persistence + replay ───────────────────────────────────────

def test_disk_persistence_on_terminal_failure(tmp_path):
    svc, sent = make_service(
        tmp_path,
        responses=[(500, {}), (500, {}), (500, {})],
        max_attempts=3,
    )
    ok = svc.send_trace_dict(_trace(trace_id="persist-me"))
    assert ok is False
    files = list(tmp_path.glob("*.json"))
    assert len(files) == 1
    # File content contains the trace payload
    saved = json.loads(files[0].read_text())
    assert saved["trace_id"] == "persist-me"


def test_replay_drains_disk_queue_on_startup(tmp_path):
    # Pre-seed the directory with two saved traces from a prior process.
    (tmp_path / "0001-a.json").write_text(json.dumps(_trace(trace_id="old-1")))
    (tmp_path / "0002-b.json").write_text(json.dumps(_trace(trace_id="old-2")))

    svc, sent = make_service(
        tmp_path,
        responses=[(200, {}), (200, {})],
        max_attempts=1,
        enable_replay=True,
    )
    # Wait for the replay thread to complete
    if hasattr(svc, "_replay_thread"):
        svc._replay_thread.join(timeout=2.0)
    remaining = list(tmp_path.glob("*.json"))
    assert len(remaining) == 0
    # Both traces were POSTed; order preserved oldest → newest
    trace_ids = [p["trace_id"] for p in sent]
    assert trace_ids == ["old-1", "old-2"]
    assert svc.metrics_snapshot()["replayed_total"] == 2


def test_replay_stops_on_first_failure(tmp_path):
    # 3 files, but the gateway returns 500 on the second — replay
    # should stop and leave the remaining files on disk.
    for i, tid in enumerate(["a", "b", "c"], start=1):
        (tmp_path / f"000{i}-x.json").write_text(json.dumps(_trace(trace_id=tid)))

    svc, sent = make_service(
        tmp_path,
        responses=[(200, {}), (500, {}), (500, {}), (500, {})],
        max_attempts=1,   # replay uses same retry policy — no retries on 500
        enable_replay=True,
    )
    if hasattr(svc, "_replay_thread"):
        svc._replay_thread.join(timeout=2.0)

    # First file drained; second failed and stayed with the third.
    remaining_ids = sorted(p.name for p in tmp_path.glob("*.json"))
    assert len(remaining_ids) == 2


# ── Metrics snapshot ────────────────────────────────────────────────

def test_metrics_snapshot_shape(tmp_path):
    svc, sent = make_service(tmp_path, responses=[(200, {})])
    svc.send_trace_dict(_trace())
    snap = svc.metrics_snapshot()
    for key in (
        "traces_sent", "traces_failed", "traces_persisted",
        "retries_total", "replayed_total", "circuit_trips",
        "circuit_state", "queue_depth", "queue_maxsize", "batch_depth",
        "disk_backlog",
    ):
        assert key in snap
    assert snap["traces_sent"] == 1
    assert snap["circuit_state"] == STATE_CLOSED
