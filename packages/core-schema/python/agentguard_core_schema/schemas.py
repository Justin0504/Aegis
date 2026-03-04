from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, field_validator
import hashlib
import json


class RiskLevel(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class ApprovalStatus(str, Enum):
    APPROVED = "APPROVED"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    REJECTED = "REJECTED"
    AUTO_APPROVED = "AUTO_APPROVED"


class Environment(str, Enum):
    DEVELOPMENT = "DEVELOPMENT"
    STAGING = "STAGING"
    PRODUCTION = "PRODUCTION"


class RetrievedSnippet(BaseModel):
    source: str
    content: str
    relevance_score: float = Field(ge=0.0, le=1.0)


class InputContext(BaseModel):
    prompt: str
    retrieved_snippets: Optional[List[RetrievedSnippet]] = None
    system_context: Optional[Dict[str, Any]] = None


class ThoughtChain(BaseModel):
    raw_tokens: str
    parsed_steps: Optional[List[str]] = None
    confidence_score: Optional[float] = Field(None, ge=0.0, le=1.0)


class ToolCall(BaseModel):
    tool_name: str
    function: str
    arguments: Dict[str, Any]
    timestamp: datetime


class Observation(BaseModel):
    raw_output: Any
    error: Optional[str] = None
    duration_ms: float = Field(gt=0)
    metadata: Optional[Dict[str, Any]] = None


class SafetyValidation(BaseModel):
    policy_name: str
    passed: bool
    violations: Optional[List[str]] = None
    risk_level: RiskLevel


class AgentActionTrace(BaseModel):
    trace_id: UUID = Field(default_factory=uuid4)
    parent_trace_id: Optional[UUID] = None
    agent_id: UUID
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    sequence_number: int = Field(ge=0)

    # Core fields
    input_context: InputContext
    thought_chain: ThoughtChain
    tool_call: ToolCall
    observation: Observation

    # Security & Integrity
    integrity_hash: str = Field(pattern=r"^[a-f0-9]{64}$", description="SHA-256 hash")
    previous_hash: Optional[str] = Field(None, pattern=r"^[a-f0-9]{64}$")
    signature: Optional[str] = None

    # Safety & Compliance
    safety_validation: Optional[SafetyValidation] = None
    approval_status: Optional[ApprovalStatus] = None
    approved_by: Optional[str] = None

    # Metadata
    environment: Environment = Environment.DEVELOPMENT
    version: str = "1.0.0"
    tags: Optional[List[str]] = None

    @field_validator("integrity_hash", "previous_hash")
    @classmethod
    def validate_hash(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not all(c in "0123456789abcdefABCDEF" for c in v):
            raise ValueError("Invalid hash format")
        return v.lower() if v else v


class TraceBundle(BaseModel):
    bundle_id: UUID = Field(default_factory=uuid4)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    traces: List[AgentActionTrace]
    metadata: Dict[str, Any] = Field(
        default_factory=lambda: {
            "agent_id": None,
            "session_id": None,
            "export_reason": "",
            "total_traces": 0,
            "hash_chain_valid": False,
            "signature": None,
        }
    )


class CreateTraceRequest(BaseModel):
    parent_trace_id: Optional[UUID] = None
    agent_id: UUID
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    sequence_number: int = Field(ge=0)

    input_context: InputContext
    thought_chain: ThoughtChain
    tool_call: ToolCall
    observation: Observation

    previous_hash: Optional[str] = Field(None, pattern=r"^[a-f0-9]{64}$")

    safety_validation: Optional[SafetyValidation] = None
    approval_status: Optional[ApprovalStatus] = None
    approved_by: Optional[str] = None

    environment: Environment = Environment.DEVELOPMENT
    version: str = "1.0.0"
    tags: Optional[List[str]] = None


class TraceQuery(BaseModel):
    agent_id: Optional[UUID] = None
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    risk_level: Optional[RiskLevel] = None
    approval_status: Optional[ApprovalStatus] = None
    limit: int = Field(default=100, gt=0, le=1000)
    offset: int = Field(default=0, ge=0)


def calculate_trace_hash(trace: Dict[str, Any]) -> str:
    """Calculate SHA-256 hash for a trace object."""
    # Extract relevant fields for hashing
    hash_content = {
        "trace_id": str(trace.get("trace_id", "")),
        "agent_id": str(trace.get("agent_id", "")),
        "timestamp": str(trace.get("timestamp", "")),
        "input_context": trace.get("input_context", {}),
        "thought_chain": trace.get("thought_chain", {}),
        "tool_call": trace.get("tool_call", {}),
        "observation": trace.get("observation", {}),
        "previous_hash": trace.get("previous_hash", ""),
    }

    # Serialize to JSON with sorted keys for consistency
    content = json.dumps(hash_content, sort_keys=True, default=str)

    # Calculate SHA-256 hash
    return hashlib.sha256(content.encode()).hexdigest()


def validate_trace_chain(traces: List[AgentActionTrace]) -> bool:
    """Validate the hash chain integrity of a list of traces."""
    if not traces:
        return True

    for i in range(1, len(traces)):
        if traces[i].previous_hash != traces[i - 1].integrity_hash:
            return False

    return True