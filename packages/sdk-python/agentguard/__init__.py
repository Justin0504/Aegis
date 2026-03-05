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
    """
    Wrap a dict of tool functions with tracing — no decorators needed.

    Usage:
        import agentguard
        agentguard.patch("http://localhost:8080", agent_id="my-agent")

        tools = agentguard.wrap_tools({
            "web_search":  web_search,
            "execute_sql": execute_sql,
        })
    """
    return _get_default_guard().wrap_tools(tool_dict)


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

        # Now use wrap_tools or @guard.trace as normal
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


__all__ = [
    "AgentGuard",
    "AgentGuardConfig",
    "patch",
    "trace",
    "wrap_tools",
]

__version__ = "1.1.6"