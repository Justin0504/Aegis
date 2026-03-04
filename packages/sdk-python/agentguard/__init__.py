"""AgentGuard: High-integrity auditing system for AI Agents."""

from .core.tracer import AgentGuard
from .core.decorators import trace
from .core.config import AgentGuardConfig

# Initialize default instance
agent_guard = AgentGuard()

# Export main decorator from default instance
trace = agent_guard.trace

__all__ = [
    "AgentGuard",
    "AgentGuardConfig",
    "agent_guard",
    "trace",
]

__version__ = "1.0.0"