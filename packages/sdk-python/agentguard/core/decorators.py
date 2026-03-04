"""Decorator functions for AgentGuard."""

from typing import Callable, Optional

# This will be set by the AgentGuard instance
_default_tracer = None


def trace(
    func: Optional[Callable] = None,
    *,
    tool_name: Optional[str] = None,
    capture_thought_chain: bool = True,
):
    """
    Decorator to trace function execution using the default AgentGuard instance.

    Usage:
        @trace
        def my_function():
            pass

        @trace(tool_name="custom_tool")
        def another_function():
            pass
    """
    if _default_tracer is None:
        raise RuntimeError(
            "AgentGuard not initialized. Import from agentguard instead: "
            "from agentguard import trace"
        )

    return _default_tracer.trace(
        func,
        tool_name=tool_name,
        capture_thought_chain=capture_thought_chain,
    )


def set_default_tracer(tracer):
    """Set the default tracer instance (internal use only)."""
    global _default_tracer
    _default_tracer = tracer