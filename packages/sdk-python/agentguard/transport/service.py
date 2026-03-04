"""Transport service for sending traces to the gateway."""

import asyncio
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
                # Check if we should flush
                should_flush = (
                    len(self._batch) >= self.config.batch_size
                    or (time.time() - self._last_flush) >= self.config.flush_interval_seconds
                )

                if should_flush and self._batch:
                    self._flush_batch()

                # Get next trace with timeout
                try:
                    trace = self._trace_queue.get(timeout=0.1)
                    self._batch.append(trace)
                except queue.Empty:
                    continue

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
            # Send batch
            response = self._client.post(
                "/api/v1/traces/batch",
                json={
                    "traces": [trace.model_dump(mode="json") for trace in batch],
                    "agent_id": self.config.agent_id,
                },
            )
            response.raise_for_status()
        except Exception as e:
            print(f"Failed to send batch: {e}")
            if self.config.enable_local_fallback:
                for trace in batch:
                    self._save_trace_locally(trace)

    def _save_trace_locally(self, trace: AgentActionTrace):
        """Save trace to local storage as fallback."""
        if not self.config.local_storage_path:
            storage_path = Path.home() / ".agentguard" / "traces"
        else:
            storage_path = Path(self.config.local_storage_path)

        storage_path.mkdir(parents=True, exist_ok=True)

        # Save trace as JSON file
        trace_file = storage_path / f"{trace.trace_id}_{trace.timestamp.isoformat()}.json"
        with open(trace_file, "w") as f:
            json.dump(trace.model_dump(mode="json"), f, indent=2)

    def shutdown(self):
        """Shutdown the transport service."""
        self._shutdown = True

        # Flush remaining traces
        if self._batch:
            self._flush_batch()

        # Close HTTP client
        self._client.close()

    def __del__(self):
        """Cleanup on deletion."""
        self.shutdown()