"""Canonical record schema for the unified AEGIS benchmark.

All loaders normalize per-source data to `BenchRecord`. Downstream baselines
and methods consume only this shape, so adding a new dataset never requires
touching evaluation code.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class Label(str, Enum):
    BENIGN = "benign"
    MALICIOUS = "malicious"


class AttackCategory(str, Enum):
    SQL_INJECTION = "sql_injection"
    PATH_TRAVERSAL = "path_traversal"
    SHELL_INJECTION = "shell_injection"
    PROMPT_INJECTION = "prompt_injection"
    SENSITIVE_FILE = "sensitive_file"
    DATA_EXFILTRATION = "data_exfiltration"
    PII_LEAKAGE = "pii_leakage"
    INDIRECT_INJECTION = "indirect_injection"
    UNAUTHORIZED_ACTION = "unauthorized_action"
    OTHER = "other"


class Distribution(str, Enum):
    """Provenance partition for honest reporting (responds to reviewer F1)."""
    IN_DIST = "in_distribution"      # authored by us, regex-aware
    NEAR_OOD = "near_ood"            # public injection benchmarks
    FAR_OOD = "far_ood"              # different style / framework / domain


class Granularity(str, Enum):
    """Tool API granularity (responds to reviewer F7)."""
    COARSE = "coarse"   # e.g. execute_sql(query: str)
    FINE = "fine"       # e.g. query_users(user_id: int)
    UNKNOWN = "unknown"


class ToolCall(BaseModel):
    """A single intercepted tool invocation (matches gateway /api/v1/check input)."""
    tool_name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    framework: str | None = None       # anthropic, openai, langchain, ...
    model: str | None = None


class BenchRecord(BaseModel):
    """One benchmark item — the unit of evaluation."""

    id: str                            # globally unique, stable
    source: str                        # injecagent / agentdojo / toolemu / owasp / toolbench / sharegpt / aegis-self
    label: Label
    category: AttackCategory | None = None  # only for malicious

    # The tool call that should/should not be blocked.
    tool_call: ToolCall

    # Optional context: the user / system messages that led here. Useful for
    # baselines that look at intent (LLM-judge) and for sequence-level methods.
    conversation: list[dict[str, str]] = Field(default_factory=list)

    # Multi-step: if present, this record is one step of a longer trace.
    session_id: str | None = None
    step_index: int | None = None

    # Provenance partitioning.
    distribution: Distribution = Distribution.IN_DIST
    granularity: Granularity = Granularity.UNKNOWN

    # Free-form notes (license, original case id, ground-truth rationale, etc.)
    meta: dict[str, Any] = Field(default_factory=dict)


class Decision(str, Enum):
    ALLOW = "allow"
    BLOCK = "block"
    PENDING = "pending"


class Prediction(BaseModel):
    """One model/baseline output for one BenchRecord."""
    record_id: str
    decision: Decision
    risk_score: float | None = None    # 0..1 if available
    latency_ms: float | None = None
    cost_usd: float | None = None
    layer_fired: Literal["L1", "L2", "L3", "none"] | None = None
    rationale: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict)
