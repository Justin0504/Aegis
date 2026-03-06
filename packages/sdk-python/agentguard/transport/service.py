"""Transport service for sending traces to the gateway."""

import atexit
import json
import queue
import threading
import time
from pathlib import Path
from typing import List, Optional

import httpx
from agentguard_core_schema import AgentActionTrace

from ..core.config import AgentGuardConfig, TransportMode


class TransportService:
    """Service for sending traces to the AgentGuard gateway."""

    def __init__(self, config: AgentGuardConfig):
        self.config = config
        self._trace_queue: queue.Queue = queue.Queue(maxsize=config.max_queue_size)
        self._batch: List[AgentActionTrace] = []
        self._last_flush = time.time()
        self._shutdown = False

        # HTTP client
        self._client = httpx.Client(
            base_url=config.gateway_url,
            timeout=30.0,
            headers={"Content-Type": "application/json"},
        )

        # Start background thread if async is enabled
        if config.enable_async:
            self._worker_thread = threading.Thread(target=self._background_worker, daemon=True)
            self._worker_thread.start()

        # Flush on clean exit
        atexit.register(self.shutdown)

    def send_trace_dict(self, trace_dict: dict) -> bool:
        """Send a pre-serialized trace dict (allows extra fields like session_id)."""
        if self.config.enable_async:
            try:
                self._trace_queue.put_nowait(trace_dict)
                return True
            except queue.Full:
                return False
        else:
            try:
                response = self._client.post("/api/v1/traces", json=trace_dict)
                response.raise_for_status()
                return True
            except Exception as e:
                print(f"Failed to send trace: {e}")
                return False

    def send_trace(self, trace: AgentActionTrace) -> bool:
        """Send a trace to the gateway."""
        if self.config.enable_async:
            try:
                self._trace_queue.put_nowait(trace)
                return True
            except queue.Full:
                # Queue is full, handle based on config
                if self.config.enable_local_fallback:
                    self._save_trace_locally(trace)
                    return True
                return False
        else:
            # Synchronous send
            return self._send_trace_sync(trace)

    def _send_trace_sync(self, trace: AgentActionTrace) -> bool:
        """Synchronously send a trace."""
        try:
            response = self._client.post(
                "/api/v1/traces",
                json=trace.model_dump(mode="json"),
            )
            response.raise_for_status()
            return True
        except Exception as e:
            print(f"Failed to send trace: {e}")
            if self.config.enable_local_fallback:
                self._save_trace_locally(trace)
            return False

    def _background_worker(self):
        """Background worker for async trace sending."""
        while not self._shutdown:
            try:
                # Drain queue into batch
                try:
                    item = self._trace_queue.get(timeout=0.1)
                    self._batch.append(item)
                except queue.Empty:
                    pass

                # Flush if batch is full or interval elapsed
                should_flush = (
                    len(self._batch) >= self.config.batch_size
                    or (time.time() - self._last_flush) >= self.config.flush_interval_seconds
                )
                if should_flush and self._batch:
                    self._flush_batch()

            except Exception as e:
                print(f"Transport worker error: {e}")
                time.sleep(1)

    def _flush_batch(self):
        """Flush the current batch of traces."""
        if not self._batch:
            return

        batch = self._batch[:]
        self._batch.clear()
        self._last_flush = time.time()

        try:
            def _serialise(t):
                return t if isinstance(t, dict) else t.model_dump(mode="json")
            # Send batch
            response = self._client.post(
                "/api/v1/traces/batch",
                json={
                    "traces": [_serialise(t) for t in batch],
                    "agent_id": self.config.agent_id,
                },
            )
            response.raise_for_status()
        except Exception as e:
            print(f"Failed to send batch: {e}")
            if self.config.enable_local_fallback:
                for trace in batch:
                    self._save_trace_locally(trace)

    def _save_trace_locally(self, trace):
        """Save trace to local storage as fallback."""
        if not self.config.local_storage_path:
            storage_path = Path.home() / ".agentguard" / "traces"
        else:
            storage_path = Path(self.config.local_storage_path)

        storage_path.mkdir(parents=True, exist_ok=True)

        data = trace if isinstance(trace, dict) else trace.model_dump(mode="json")
        trace_file = storage_path / f"{data.get('trace_id', 'unknown')}.json"
        with open(trace_file, "w") as f:
            json.dump(data, f, indent=2)

    def shutdown(self):
        """Shutdown the transport service."""
        if self._shutdown:
            return
        self._shutdown = True

        # Drain queue into batch
        while not self._trace_queue.empty():
            try:
                self._batch.append(self._trace_queue.get_nowait())
            except queue.Empty:
                break

        # Flush remaining traces
        if self._batch:
            self._flush_batch()

        # Close HTTP client
        self._client.close()

    def __del__(self):
        """Cleanup on deletion."""
        self.shutdown()