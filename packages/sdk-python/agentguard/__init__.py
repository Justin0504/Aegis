"""AgentGuard: High-integrity auditing system for AI Agents."""

from .core.tracer import AgentGuard
from .core.config import AgentGuardConfig
from typing import Optional

# Lazy default instance (only created on first use)
_default_guard: Optional[AgentGuard] = None


def _get_default_guard() -> AgentGuard:
    global _default_guard
    if _default_guard is None:
        _default_guard = AgentGuard()
    return _default_guard


def trace(func=None, *, tool_name=None, **kwargs):
    """Module-level trace decorator using the default guard instance."""
    return _get_default_guard().trace(func, tool_name=tool_name, **kwargs)


def wrap_tools(tool_dict: dict) -> dict:
    """Wrap a dict of tool functions with tracing."""
    return _get_default_guard().wrap_tools(tool_dict)


def watch(namespace: dict) -> dict:
    """
    Scan a namespace and wrap all callables with tracing in-place.

    Usage:
        def web_search(query): ...
        def execute_sql(sql): ...
        tool_fn = agentguard.watch(locals())
    """
    return _get_default_guard().watch(namespace)


def patch(
    gateway_url: str = "http://localhost:8080",
    agent_id: Optional[str] = None,
    enable_signing: bool = False,
) -> AgentGuard:
    """
    One-liner setup — patches the default guard and returns it.

    Usage:
        import agentguard
        guard = agentguard.patch("http://localhost:8080", agent_id="my-agent")
        tools = guard.wrap_tools({"search": my_search_fn})
    """
    from uuid import uuid4
    global _default_guard

    config = AgentGuardConfig(
        agent_id=agent_id or str(uuid4()),
        gateway_url=gateway_url,
        enable_signing=enable_signing,
    )
    _default_guard = AgentGuard(config)
    return _default_guard


def auto(
    gateway_url: str = "http://localhost:8080",
    agent_id: Optional[str] = None,
) -> AgentGuard:
    """
    Fully automatic instrumentation — zero code changes to your agent.

    Patches Anthropic and OpenAI SDK at the message level:
    - Detects tool_use/tool_calls in LLM responses
    - Captures tool arguments automatically
    - Captures tool results from the next API call
    - Sends complete traces to AEGIS gateway

    Usage:
        import agentguard
        agentguard.auto("http://localhost:8080", agent_id="my-agent")

        # Everything below is UNCHANGED — no decorators, no wrap_tools
        client = anthropic.Anthropic()
        response = client.messages.create(model=..., tools=..., messages=...)
    """
    from uuid import uuid4
    from .interceptors.auto import AutoInstrument
    global _default_guard

    config = AgentGuardConfig(
        agent_id=agent_id or str(uuid4()),
        gateway_url=gateway_url,
        enable_signing=False,
    )
    guard = AgentGuard(config)
    _default_guard = guard

    instrument = AutoInstrument(guard)
    anthropic_ok = instrument.patch_anthropic()
    openai_ok    = instrument.patch_openai()

    patched = []
    if anthropic_ok: patched.append("Anthropic")
    if openai_ok:    patched.append("OpenAI")

    if patched:
        print(f"[AEGIS] Auto-instrumented: {', '.join(patched)} → {gateway_url}")
    else:
        print("[AEGIS] No supported SDK found (install anthropic or openai)")

    return guard


__all__ = [
    "AgentGuard",
    "AgentGuardConfig",
    "auto",
    "patch",
    "trace",
    "watch",
    "wrap_tools",
]

__version__ = "1.1.8"