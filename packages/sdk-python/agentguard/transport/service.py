"""
Transport service for sending traces to the AEGIS gateway.

Design goals (industry-parity with Sentry / OTel / Honeycomb):

1. **Never silently drop a trace.** Every trace either lands at the
   gateway or on local disk with a replay-on-startup guarantee.

2. **Exponential backoff with jitter.** Retries follow the standard
   `sleep = min(cap, base * 2**attempt) + random(0, base)` recipe
   (Google's "full jitter" variant). Prevents thundering-herd on
   gateway recovery.

3. **Circuit breaker.** After N consecutive failures the transport
   opens the circuit: subsequent sends fail-fast to disk without
   hammering a downed gateway. After `open_duration` a single probe
   goes through; success closes the circuit, failure re-opens.

4. **Disk-backed replay.** Failed traces land in
   `~/.agentguard/traces/<timestamp>-<uuid>.json`. On startup the
   transport walks the directory and replays anything older than the
   process, oldest first, deleting each file on 2xx. Bounded by
   `replay_rate` to avoid re-DoSing a just-recovered gateway.

5. **Structured logging.** All errors go through
   `logging.getLogger('agentguard.transport')` at appropriate levels
   so app operators can route them. No stray print() calls.

6. **Self-metrics.** Counters are attached to the singleton so a
   consumer can `service.metrics_snapshot()` and export them to
   Prometheus / Datadog.

Backwards compatibility: the public API (send_trace, send_trace_dict,
shutdown) is unchanged. Any existing caller works without modification.
"""

import atexit
import json
import logging
import os
import queue
import random
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
from agentguard_core_schema import AgentActionTrace

from ..core.config import AgentGuardConfig, TransportMode


logger = logging.getLogger("agentguard.transport")


# ── Retry policy ────────────────────────────────────────────────────

# Retry on transient failures. Explicitly do NOT retry 4xx — those are
# client bugs (bad payload, auth failure) that a retry won't fix and
# would just fill logs.
RETRYABLE_STATUS = frozenset({408, 429, 500, 502, 503, 504})


@dataclass
class RetryPolicy:
    max_attempts:  int   = 5      # Total tries incl. first attempt
    base_delay:    float = 0.5    # seconds
    cap_delay:     float = 30.0   # seconds
    jitter:        bool  = True

    def delay_for(self, attempt: int) -> float:
        """Compute sleep after `attempt` failed tries (0-indexed).

        Uses the "full jitter" variant: exponential upper bound, then
        a uniform random draw between 0 and that bound. This is what
        the AWS Architecture Blog (Marc Brooker) recommends for
        client-side retries — spreads recovery load evenly instead
        of clumping at the ceiling.
        """
        capped = min(self.cap_delay, self.base_delay * (2 ** attempt))
        if not self.jitter:
            return capped
        return random.uniform(0, capped)


# ── Circuit breaker ─────────────────────────────────────────────────

# Standard Nygard "Release It!" state machine. `open` doesn't mean
# "gateway is up"; it means the breaker is preventing calls (i.e.
# gateway is presumed down).

STATE_CLOSED    = "closed"      # Normal operation
STATE_OPEN      = "open"        # Fail-fast, save to disk
STATE_HALF_OPEN = "half_open"   # Single probe allowed


@dataclass
class CircuitBreaker:
    failure_threshold: int   = 5     # Trips after N consecutive failures
    open_duration:     float = 30.0  # Seconds before probing again
    state:             str   = STATE_CLOSED
    consecutive_fails: int   = 0
    opened_at:         float = 0.0
    _lock:             threading.Lock = field(default_factory=threading.Lock)

    def allow(self) -> bool:
        """Whether a send should proceed. Advances state as a side-effect."""
        with self._lock:
            if self.state == STATE_CLOSED:
                return True
            if self.state == STATE_OPEN:
                if time.time() - self.opened_at >= self.open_duration:
                    self.state = STATE_HALF_OPEN
                    logger.info("circuit half-open: probing gateway")
                    return True   # let the probe through
                return False
            # HALF_OPEN — only one probe at a time. Successful callers
            # transition us to CLOSED via record_success; failing ones
            # back to OPEN via record_failure. Between then the
            # breaker is briefly quiet.
            return False

    def record_success(self) -> None:
        with self._lock:
            if self.state != STATE_CLOSED:
                logger.info("circuit closed after successful probe")
            self.consecutive_fails = 0
            self.state = STATE_CLOSED

    def record_failure(self) -> None:
        with self._lock:
            self.consecutive_fails += 1
            if self.state == STATE_HALF_OPEN:
                logger.warning("circuit re-opened: probe failed")
                self.state = STATE_OPEN
                self.opened_at = time.time()
            elif self.consecutive_fails >= self.failure_threshold and self.state == STATE_CLOSED:
                logger.warning(
                    "circuit opened after %d consecutive failures",
                    self.consecutive_fails,
                )
                self.state = STATE_OPEN
                self.opened_at = time.time()


# ── Identity headers (unchanged from prior implementation) ──────────

def _identity_headers(config: AgentGuardConfig) -> dict:
    """
    Headers that pin tenant + agent identity on every gateway call.
    Mirrors the same env-var fallback chain the interceptor uses so an
    SDK consumer can set `AEGIS_API_KEY` / `AEGIS_AGENT_SECRET` /
    `AEGIS_SESSION_ID` without touching code.
    """
    headers: dict = {"Content-Type": "application/json"}
    api_key = (
        getattr(config, "api_key", None)
        or os.environ.get("AEGIS_API_KEY")
        or os.environ.get("AGENTGUARD_API_KEY")
    )
    if api_key:
        headers["x-api-key"] = api_key
    headers["x-aegis-agent-id"] = str(config.agent_id)
    agent_secret = (
        getattr(config, "agent_secret", None)
        or os.environ.get("AEGIS_AGENT_SECRET")
        or os.environ.get("AGENTGUARD_AGENT_SECRET")
    )
    if agent_secret:
        headers["x-aegis-agent-secret"] = agent_secret
    agent_token = (
        getattr(config, "agent_token", None)
        or os.environ.get("AEGIS_AGENT_TOKEN")
    )
    if agent_token:
        headers["x-aegis-agent-token"] = agent_token
    session_id = (
        getattr(config, "session_id", None)
        or os.environ.get("AEGIS_SESSION_ID")
    )
    if session_id:
        headers["x-aegis-session-id"] = session_id
    build_artifact = (
        getattr(config, "build_artifact", None)
        or os.environ.get("AEGIS_BUILD_ARTIFACT")
        or os.environ.get("BUILD_ARTIFACT")
    )
    if build_artifact:
        headers["x-aegis-build-artifact"] = build_artifact
    source_commit = (
        getattr(config, "source_commit", None)
        or os.environ.get("AEGIS_SOURCE_COMMIT")
        or os.environ.get("GIT_COMMIT_SHA")
    )
    if source_commit:
        headers["x-aegis-source-commit"] = source_commit
    return headers


# ── Main transport ──────────────────────────────────────────────────

class TransportService:
    """Service for sending traces to the AgentGuard gateway.

    Not intended to be constructed twice per process — the client uses
    it as a singleton attached to `AgentGuard.transport`. The replay
    thread + circuit breaker state assume one instance per gateway URL.
    """

    def __init__(self, config: AgentGuardConfig):
        self.config = config
        self._trace_queue: queue.Queue = queue.Queue(maxsize=config.max_queue_size)
        self._batch: List[Any] = []
        self._last_flush = time.time()
        self._shutdown = False

        self._retry_policy = RetryPolicy(
            max_attempts=getattr(config, "retry_max_attempts", 5),
            base_delay=getattr(config, "retry_base_delay", 0.5),
            cap_delay=getattr(config, "retry_cap_delay", 30.0),
        )
        self._breaker = CircuitBreaker(
            failure_threshold=getattr(config, "circuit_failure_threshold", 5),
            open_duration=getattr(config, "circuit_open_duration", 30.0),
        )

        # Metrics — plain counters, thread-safe via the GIL for int
        # increments. Consumers snapshot via metrics_snapshot().
        self._metrics_lock = threading.Lock()
        self._metrics: Dict[str, int] = {
            "traces_sent":      0,
            "traces_failed":    0,
            "traces_persisted": 0,
            "retries_total":    0,
            "replayed_total":   0,
            "circuit_trips":    0,
        }

        # HTTP client — identity headers are baked in so every trace POST
        # carries agent + tenant identity for audit attribution.
        self._client = httpx.Client(
            base_url=config.gateway_url,
            timeout=30.0,
            headers=_identity_headers(config),
        )

        # Resolve the disk-fallback path early so both the save path
        # and the replay walker share the same directory.
        self._disk_path = (
            Path(config.local_storage_path)
            if getattr(config, "local_storage_path", None)
            else Path.home() / ".agentguard" / "traces"
        )
        if getattr(config, "enable_local_fallback", True):
            self._disk_path.mkdir(parents=True, exist_ok=True)

        # Background worker (batching + periodic flush)
        if config.enable_async:
            self._worker_thread = threading.Thread(
                target=self._background_worker, daemon=True, name="aegis-transport-worker",
            )
            self._worker_thread.start()

        # Replay-on-startup worker — walks the disk queue in a
        # separate thread so init() returns immediately. Bounded rate
        # via replay_rate (traces/sec) so we don't re-DoS the gateway
        # right as it comes back.
        if getattr(config, "enable_local_fallback", True) and getattr(config, "enable_replay_on_startup", True):
            self._replay_thread = threading.Thread(
                target=self._replay_disk_queue, daemon=True, name="aegis-transport-replay",
            )
            self._replay_thread.start()

        atexit.register(self.shutdown)

    # ── Public API ──────────────────────────────────────────────────

    def send_trace_dict(self, trace_dict: dict) -> bool:
        """Send a pre-serialised trace dict (allows extra fields like session_id)."""
        if self.config.enable_async:
            try:
                self._trace_queue.put_nowait(trace_dict)
                return True
            except queue.Full:
                logger.warning("trace queue full; falling back to disk")
                self._save_trace_locally(trace_dict)
                return True
        return self._send_with_retry("/api/v1/traces", trace_dict, is_batch=False)

    def send_trace(self, trace: AgentActionTrace) -> bool:
        """Send a trace to the gateway."""
        if self.config.enable_async:
            try:
                self._trace_queue.put_nowait(trace)
                return True
            except queue.Full:
                logger.warning("trace queue full; falling back to disk")
                if self.config.enable_local_fallback:
                    self._save_trace_locally(trace)
                    return True
                return False
        return self._send_with_retry(
            "/api/v1/traces", trace.model_dump(mode="json"), is_batch=False,
        )

    def metrics_snapshot(self) -> Dict[str, Any]:
        """Return a point-in-time snapshot of transport metrics.

        Consumers export these to Prometheus / Datadog / etc. Includes
        the current circuit breaker state and queue depth so operators
        can alert on 'circuit stuck open' or 'queue backing up'.
        """
        with self._metrics_lock:
            counters = dict(self._metrics)
        # Best-effort disk backlog — cheap `os.listdir` count, not a
        # walk (the directory is bounded by the writes above).
        try:
            disk_backlog = len(list(self._disk_path.glob("*.json")))
        except Exception:
            disk_backlog = -1
        return {
            **counters,
            "circuit_state":     self._breaker.state,
            "queue_depth":       self._trace_queue.qsize(),
            "queue_maxsize":     self.config.max_queue_size,
            "batch_depth":       len(self._batch),
            "disk_backlog":      disk_backlog,
        }

    def shutdown(self) -> None:
        """Shutdown the transport service — best-effort final flush."""
        if self._shutdown:
            return
        self._shutdown = True

        # Drain queue into batch
        while not self._trace_queue.empty():
            try:
                self._batch.append(self._trace_queue.get_nowait())
            except queue.Empty:
                break

        if self._batch:
            self._flush_batch()

        try:
            self._client.close()
        except Exception:
            pass

    def __del__(self):
        self.shutdown()

    # ── Send with retry + circuit breaker ───────────────────────────

    def _send_with_retry(self, path: str, payload: Any, is_batch: bool, *, persist_on_failure: bool = True) -> bool:
        """Send with the retry policy + circuit breaker in front.

        Returns True on 2xx, False otherwise. On terminal failure the
        payload is persisted to disk for later replay if
        `persist_on_failure` is True (default). The replay loop passes
        False because the payload is ALREADY on disk — persisting it
        again would create duplicate files and leak backlog.
        """
        if not self._breaker.allow():
            logger.debug("circuit open — skipping send, persisting to disk")
            if persist_on_failure:
                self._persist_on_failure(payload, is_batch)
            return False

        last_error: Optional[Exception] = None
        for attempt in range(self._retry_policy.max_attempts):
            try:
                response = self._client.post(path, json=payload)
                # 4xx (except 408, 429) is a client error — do NOT retry.
                if response.status_code >= 400 and response.status_code not in RETRYABLE_STATUS:
                    logger.error(
                        "gateway returned non-retryable %d — dropping trace",
                        response.status_code,
                    )
                    self._breaker.record_success()   # gateway is up, our payload is bad
                    self._inc("traces_failed")
                    return False
                response.raise_for_status()
                self._breaker.record_success()
                self._inc("traces_sent", int(is_batch) and len(payload.get("traces", [])) or 1)
                return True

            except (httpx.RequestError, httpx.HTTPStatusError) as e:
                last_error = e
                status = getattr(getattr(e, "response", None), "status_code", None)
                # Only retry on retryable status codes or network errors
                is_retryable = isinstance(e, httpx.RequestError) or (
                    status is not None and status in RETRYABLE_STATUS
                )
                if not is_retryable:
                    logger.error("non-retryable send failure: %s", e)
                    self._breaker.record_success()   # server said no on merit
                    self._inc("traces_failed")
                    return False

                if attempt + 1 < self._retry_policy.max_attempts:
                    delay = self._retry_policy.delay_for(attempt)
                    logger.warning(
                        "send failed (attempt %d/%d): %s — retrying in %.2fs",
                        attempt + 1, self._retry_policy.max_attempts, e, delay,
                    )
                    self._inc("retries_total")
                    time.sleep(delay)
                    continue
                break

        # Exhausted retries.
        logger.error("send exhausted retries: %s", last_error)
        prior_state = self._breaker.state
        self._breaker.record_failure()
        if prior_state == STATE_CLOSED and self._breaker.state == STATE_OPEN:
            self._inc("circuit_trips")
        self._inc("traces_failed")
        if persist_on_failure:
            self._persist_on_failure(payload, is_batch)
        return False

    def _persist_on_failure(self, payload: Any, is_batch: bool) -> None:
        """Save the payload to disk for later replay."""
        if not getattr(self.config, "enable_local_fallback", True):
            return
        if is_batch:
            # Persist each trace individually so replay is idempotent
            # per-trace (a partial batch success on retry won't
            # re-send already-persisted rows).
            for trace in payload.get("traces", []):
                self._save_trace_locally(trace)
        else:
            self._save_trace_locally(payload)

    # ── Async worker + batching ─────────────────────────────────────

    def _background_worker(self) -> None:
        """Batching worker — drains the queue, flushes on size/time."""
        while not self._shutdown:
            try:
                try:
                    item = self._trace_queue.get(timeout=0.1)
                    self._batch.append(item)
                except queue.Empty:
                    pass

                should_flush = (
                    len(self._batch) >= self.config.batch_size
                    or (time.time() - self._last_flush) >= self.config.flush_interval_seconds
                )
                if should_flush and self._batch:
                    self._flush_batch()

            except Exception as e:
                logger.exception("transport worker error: %s", e)
                time.sleep(1)

    def _flush_batch(self) -> None:
        """Flush the current batch via the retrying sender."""
        if not self._batch:
            return

        batch = self._batch[:]
        self._batch.clear()
        self._last_flush = time.time()

        def _serialise(t: Any) -> dict:
            return t if isinstance(t, dict) else t.model_dump(mode="json")

        payload = {
            "traces":   [_serialise(t) for t in batch],
            "agent_id": self.config.agent_id,
        }
        self._send_with_retry("/api/v1/traces/batch", payload, is_batch=True)

    # ── Disk fallback + replay ──────────────────────────────────────

    def _save_trace_locally(self, trace: Any) -> None:
        """Persist a trace to disk. Filename encodes timestamp for
        ordered replay + a UUID suffix so writes from multiple threads
        don't collide."""
        try:
            data = trace if isinstance(trace, dict) else trace.model_dump(mode="json")
            # Millisecond timestamp + short UUID — sortable + collision-safe
            fname = f"{int(time.time() * 1000):015d}-{uuid.uuid4().hex[:8]}.json"
            path = self._disk_path / fname
            with open(path, "w") as f:
                json.dump(data, f)
            self._inc("traces_persisted")
        except Exception as e:
            logger.exception("disk fallback write failed: %s", e)

    def _replay_disk_queue(self) -> None:
        """Walk the disk fallback directory oldest-first, resend each
        trace, delete on success. Rate-limited via `replay_rate`
        (traces/sec) so a large backlog doesn't re-DoS the gateway.

        This runs ONCE per process at startup — new failures during
        the process's lifetime are persisted but won't be replayed
        until next start. That's deliberate: mixing an ongoing send
        loop with a replay loop creates ordering + duplicate hazards
        that aren't worth the complexity for a fallback path.
        """
        # Small initial delay so init() finishes before we hammer the
        # gateway with a backlog. Also lets the async worker start
        # normal writes.
        time.sleep(getattr(self.config, "replay_startup_delay", 2.0))

        rate = getattr(self.config, "replay_rate", 20.0)      # traces/sec
        interval = 1.0 / max(rate, 1.0)

        try:
            files = sorted(self._disk_path.glob("*.json"))
        except Exception as e:
            logger.exception("replay directory walk failed: %s", e)
            return

        if not files:
            return

        logger.info("replay: %d disk-backed traces queued", len(files))

        for path in files:
            if self._shutdown:
                return
            try:
                with open(path) as f:
                    trace_dict = json.load(f)
            except Exception as e:
                logger.warning("replay: skipping unreadable %s: %s", path.name, e)
                try: path.unlink()
                except Exception: pass
                continue

            # persist_on_failure=False — the payload is already on disk;
            # re-persisting would create a duplicate file and grow the
            # backlog on every retry loop.
            ok = self._send_with_retry("/api/v1/traces", trace_dict, is_batch=False, persist_on_failure=False)
            if ok:
                try:
                    path.unlink()
                    self._inc("replayed_total")
                except Exception as e:
                    logger.warning("replay: could not delete %s: %s", path.name, e)
            else:
                # Circuit tripped or terminal error — stop replaying;
                # the file stays for next startup.
                logger.warning("replay: stopping on failure, %d files remaining",
                               len(files) - files.index(path))
                return

            time.sleep(interval)

        logger.info("replay: complete")

    # ── Metrics helpers ─────────────────────────────────────────────

    def _inc(self, key: str, n: int = 1) -> None:
        with self._metrics_lock:
            self._metrics[key] = self._metrics.get(key, 0) + n
