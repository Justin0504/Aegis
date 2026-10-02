"""Report newly-seen context spans to the gateway.

One of these per agent process. It remembers what it has already sent so
a long conversation --- whose whole history is re-sent on every model
call --- costs one request per *new* span rather than one per turn
squared.

FAILURE IS SILENT, ON PURPOSE

If the gateway is unreachable the agent keeps running. The consequence is
that provenance degrades to `unknown` and provenance rules stop firing,
which is the fail-soft direction already chosen everywhere else in this
layer: a security feature that takes the agent down when its telemetry
endpoint blips is worse than the risk it covers.
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from typing import Any

from .channels import ContextSpan, derive_spans

logger = logging.getLogger(__name__)

# Per session. Comfortably more spans than a ledger window holds, so the
# cache never causes a span to be withheld that the gateway still wants.
_MAX_SEEN_PER_SESSION = 512
_MAX_SESSIONS = 256


class ContextReporter:
    """Derives spans from a messages array and posts the new ones."""

    def __init__(self, post, *, enabled: bool = True) -> None:
        # `post` is injected rather than imported so this is testable
        # without a transport, and so a host application can route the
        # call through its own client.
        self._post = post
        self._enabled = enabled
        self._seen: OrderedDict[str, OrderedDict[str, None]] = OrderedDict()
        self._lock = threading.Lock()

    def report_messages(self, session_id: str, messages: Any, agent_id: str | None = None) -> int:
        """Classify `messages`, send whatever is new, return how many.

        Returns 0 when disabled, when nothing is new, or when the send
        failed --- the caller is a hot path and has nothing useful to do
        with the distinction.
        """
        if not self._enabled or not session_id:
            return 0
        try:
            spans = derive_spans(messages)
        except Exception:  # noqa: BLE001
            logger.debug("context derivation failed", exc_info=True)
            return 0
        if not spans:
            return 0

        fresh = self._take_new(session_id, spans)
        if not fresh:
            return 0
        return self._send(session_id, fresh, agent_id)

    def forget(self, session_id: str) -> None:
        with self._lock:
            self._seen.pop(session_id, None)

    # ── internals ──────────────────────────────────────────────────────

    def _take_new(self, session_id: str, spans: list[ContextSpan]) -> list[ContextSpan]:
        with self._lock:
            seen = self._seen.get(session_id)
            if seen is None:
                seen = OrderedDict()
                self._seen[session_id] = seen
                while len(self._seen) > _MAX_SESSIONS:
                    self._seen.popitem(last=False)
            self._seen.move_to_end(session_id)

            fresh: list[ContextSpan] = []
            for span in spans:
                fp = span.fingerprint()
                if fp in seen:
                    continue
                seen[fp] = None
                fresh.append(span)
            while len(seen) > _MAX_SEEN_PER_SESSION:
                seen.popitem(last=False)
            return fresh

    def _send(self, session_id: str, spans: list[ContextSpan], agent_id: str | None) -> int:
        # The gateway caps a report at 64 events; a first call on a long
        # conversation can exceed that, so chunk rather than truncate.
        sent = 0
        for i in range(0, len(spans), 64):
            chunk = spans[i : i + 64]
            payload: dict[str, Any] = {
                "session_id": session_id,
                "events": [
                    {"channel": s.channel, "text": s.text, **({"source": s.source} if s.source else {})}
                    for s in chunk
                ],
            }
            if agent_id:
                payload["agent_id"] = agent_id
            try:
                self._post("/api/v1/context", payload)
                sent += len(chunk)
            except Exception:  # noqa: BLE001
                # Degrades provenance to `unknown`; never fails the agent.
                logger.debug("context report failed", exc_info=True)
                break
        return sent
