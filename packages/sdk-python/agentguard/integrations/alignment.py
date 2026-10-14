"""
Alignment helper — call ``/api/v1/alignment/check`` from any agent
loop and, optionally, have the verdict auto-flow into the next
``/check`` so the gateway's Policy DSL can react on the same hop.

This is the framework-agnostic entry point. If your agent runs on
LangChain or CrewAI, prefer the dedicated callbacks
(``integrations.langchain.AlignmentCallback``,
``integrations.crewai.make_alignment_step_callback``) — they
capture the chain-of-thought + tool action for free. Reach for
this helper when:

- You're on a framework we don't ship a callback for (autogen,
  raw OpenAI / Anthropic tool loops, in-house agents).
- You want full control over what counts as "the goal" or "the
  thought chain" for a particular hop.

Quick start::

    from agentguard.integrations.alignment import check

    verdict = check(
        agent_id="my-agent",
        declared_goal="Summarise the customer-feedback survey.",
        thought_chain=[
            "Thought: I need to fetch the survey data first.",
        ],
        proposed_action={
            "tool_name": "execute_sql",
            "arguments": {"query": "SELECT * FROM survey"},
        },
        gateway_url="http://localhost:8080",
    )

    if verdict.get("drifted"):
        # The auditor thinks this tool call doesn't serve the
        # declared goal. Decide locally what to do.
        ...

    # The verdict is also buffered in-process keyed by agent_id;
    # the next /check call for the same agent picks it up under
    # `alignment.*` automatically.
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional, Sequence

try:
    import httpx
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "alignment helper requires httpx (a core SDK dep; reinstall agentguard-aegis)."
    ) from e

from . import _alignment_state

PROVIDERS = ("anthropic", "openai", "gemini")


def _active_session_id() -> Optional[str]:
    """The session id auto() reports context under, so the auditor reads
    the same ledger the provenance layer does."""
    try:
        from .. import _default_guard  # type: ignore[attr-defined]
        sid = getattr(getattr(_default_guard, "config", None), "session_id", None)
    except Exception:  # noqa: BLE001 — no guard configured
        sid = None
    return sid or os.environ.get("AEGIS_SESSION_ID") or None


def check(
    *,
    agent_id: str,
    declared_goal: str,
    proposed_action: dict[str, Any],
    thought_chain: Optional[Sequence[str]] = None,
    gateway_url: str = "http://localhost:8080",
    api_key: Optional[str] = None,
    provider: Optional[str] = None,
    model: Optional[str] = None,
    timeout_s: float = 10.0,
    record_for_check: bool = True,
    session_id: Optional[str] = None,
) -> dict[str, Any]:
    """POST a chain-of-thought + proposed action to the AEGIS
    alignment auditor.

    Returns the parsed JSON verdict from the gateway, typically
    ``{"score": float, "drifted": bool, "signals": [str, ...],
       "reason": str, "model": str}``.

    Network or auditor errors are surfaced as ``httpx`` exceptions.
    Callers wanting a fail-open posture should catch
    ``httpx.HTTPError`` and treat it as "no verdict."

    Parameters
    ----------
    agent_id
        Stable identifier for the calling agent. Used as the buffer
        key for the closed-loop bridge.
    declared_goal
        Plain-English statement of what the current agent run is
        trying to accomplish. The auditor uses this as the anchor.
    proposed_action
        ``{"tool_name": ..., "arguments": {...}}`` — the tool the
        agent is about to dispatch.
    thought_chain
        Optional list of intermediate reasoning steps in order. If
        omitted, the auditor scores from goal + action alone.
    provider, model
        Optional overrides for the upstream LLM judge. Defaults
        come from the gateway's configured provider.
    session_id
        The session whose context the SDK has been reporting. When
        given (default: the active guard's session, or
        ``AEGIS_SESSION_ID``), the gateway shows the auditor the tool
        output the agent read, as evidence. Without it the auditor
        judges argument values it cannot check.
    record_for_check
        When True (default), the verdict is stashed in the
        closed-loop buffer so the SDK's auto-instrumentation will
        splice it into the next ``/check`` payload for this
        ``agent_id``.
    """
    if not agent_id:
        raise ValueError("agent_id is required")
    if not declared_goal:
        raise ValueError("declared_goal is required")
    if not isinstance(proposed_action, dict) or "tool_name" not in proposed_action:
        raise ValueError("proposed_action must be a dict with at least a tool_name")
    if provider is not None and provider not in PROVIDERS:
        raise ValueError(
            f"provider must be one of {PROVIDERS}; got {provider!r}"
        )

    body: dict[str, Any] = {
        "agent_id": agent_id,
        "declared_goal": declared_goal,
        "thought_chain": list(thought_chain or []),
        "proposed_action": {
            "tool_name": proposed_action["tool_name"],
            "arguments": dict(proposed_action.get("arguments") or {}),
        },
    }
    sid = session_id or _active_session_id()
    if sid:
        body["session_id"] = sid
    if provider:
        body["provider"] = provider
    if model:
        body["model"] = model

    headers = {"content-type": "application/json"}
    key = api_key or os.environ.get("AEGIS_API_KEY", "")
    if key:
        headers["x-api-key"] = key

    url = gateway_url.rstrip("/") + "/api/v1/alignment/check"
    with httpx.Client(timeout=timeout_s) as client:
        resp = client.post(url, headers=headers, content=json.dumps(body))
    resp.raise_for_status()
    verdict = resp.json()

    if record_for_check and isinstance(verdict, dict):
        _alignment_state.record(agent_id, verdict)

    return verdict


def consume(agent_id: str) -> Optional[dict[str, Any]]:
    """Pop the most recent verdict for ``agent_id`` if still
    fresh (≤ 30 s old). Intended for callers that want to inspect
    the verdict before invoking the next tool, instead of relying
    on the auto-instrumentation's silent splice."""
    return _alignment_state.consume(agent_id)
