"""Configuration for AgentGuard SDK."""

from pathlib import Path
from typing import Optional, Dict, Any
from enum import Enum

from pydantic import BaseModel, Field, SecretStr
from agentguard_core_schema import Environment


class TransportMode(str, Enum):
    HTTP = "http"
    GRPC = "grpc"
    LOCAL = "local"


class AgentGuardConfig(BaseModel):
    """Configuration for AgentGuard SDK."""

    # Core settings
    agent_id: str = Field(description="Unique identifier for this agent")
    environment: Environment = Field(default=Environment.DEVELOPMENT)
    gateway_url: str = Field(default="http://localhost:8080")
    transport_mode: TransportMode = Field(default=TransportMode.HTTP)

    # Security settings
    private_key_path: Optional[Path] = Field(default=None, description="Path to Ed25519 private key")
    private_key_password: Optional[SecretStr] = Field(default=None, description="Password for private key")
    enable_signing: bool = Field(default=True, description="Enable cryptographic signing of traces")

    # Performance settings
    batch_size: int = Field(default=100, ge=1, le=1000)
    flush_interval_seconds: float = Field(default=5.0, ge=0.1, le=60.0)
    max_queue_size: int = Field(default=10000, ge=100)
    enable_async: bool = Field(default=True)

    # Interception settings
    capture_stdout: bool = Field(default=True)
    capture_stderr: bool = Field(default=True)
    capture_llm_calls: bool = Field(default=True)
    capture_exceptions: bool = Field(default=True)

    # Telemetry settings
    enable_telemetry: bool = Field(default=True)
    otel_endpoint: Optional[str] = Field(default=None)
    otel_headers: Dict[str, str] = Field(default_factory=dict)

    # Local storage (for offline mode)
    local_storage_path: Optional[Path] = Field(default=None)
    enable_local_fallback: bool = Field(default=True)

    # Session tracking
    session_id: Optional[str] = Field(
        default=None,
        description="Optional session ID to group related traces together."
    )

    # ── Identity headers forwarded to gateway ─────────────────────────────
    api_key: Optional[str] = Field(
        default=None,
        description=(
            "AEGIS API key (per-org). Sent as X-API-Key on every request. "
            "Falls back to env AEGIS_API_KEY / AGENTGUARD_API_KEY."
        ),
    )
    agent_secret: Optional[str] = Field(
        default=None,
        description=(
            "Optional agent secret. When the agent is registered with a "
            "secret, the SDK forwards it as X-AEGIS-Agent-Secret so the "
            "gateway's agent registry can verify identity before serving. "
            "Falls back to env AEGIS_AGENT_SECRET / AGENTGUARD_AGENT_SECRET."
        ),
    )
    agent_token: Optional[str] = Field(
        default=None,
        description=(
            "AEGIS Agent ID v1 JWT signed by the gateway. When set, the SDK "
            "forwards it as X-AEGIS-Agent-Token; the gateway uses the JWT's "
            "sub claim as the agent identity (overriding any header-claimed "
            "agent_id). Stronger proof than agent_secret. "
            "Falls back to env AEGIS_AGENT_TOKEN."
        ),
    )
    build_artifact: Optional[str] = Field(
        default=None,
        description=(
            "Container image / binary SHA-256, e.g. 'sha256:abc123...'. "
            "Reported on first sighting so the ID card carries build "
            "provenance. Falls back to env AEGIS_BUILD_ARTIFACT or BUILD_ARTIFACT."
        ),
    )
    source_commit: Optional[str] = Field(
        default=None,
        description=(
            "Source URI of the build, typically 'git+<repo>@<commit-sha>'. "
            "Falls back to env AEGIS_SOURCE_COMMIT or GIT_COMMIT_SHA."
        ),
    )

    # Blocking mode — pre-execution policy enforcement
    blocking_mode: bool = Field(
        default=False,
        description="If True, calls /api/v1/check before every tool execution. "
                    "HIGH/CRITICAL risk tools wait for human approval in the dashboard."
    )
    blocking_timeout_ms: int = Field(
        default=3000,
        description="Max ms to wait for a fast-path blocking check response."
    )
    human_approval_timeout_s: int = Field(
        default=300,
        description="Max seconds to wait for a human to approve/reject a pending check. "
                    "After this, the tool is blocked (fail-safe)."
    )
    poll_interval_s: float = Field(
        default=2.0,
        description="How often (seconds) to poll for a human approval decision."
    )
    fail_open: bool = Field(
        default=True,
        description="If True and gateway is unreachable, allow the tool call (fail-open). "
                    "Set to False for strict enforcement."
    )

    # Tool category overrides — { "my_tool_name": "database" }
    tool_categories: Dict[str, str] = Field(
        default_factory=dict,
        description="Map tool names to categories to override auto-classification."
    )

    # ── Precision controls (prevent over-blocking) ─────────────────────────

    block_threshold: str = Field(
        default="LOW",
        description=(
            "Minimum risk level at which a gateway `block` is enforced. Options: "
            "LOW | MEDIUM | HIGH | CRITICAL. Default 'LOW' enforces every block the "
            "gateway returns — the behaviour the paper measures, and the JS and Go "
            "SDKs' only behaviour. Raising it audits lower-risk blocks instead of "
            "enforcing them (a DSL rule's block or any hold is always enforced)."
        )
    )
    enforce_at: str = Field(
        default="response",
        description=(
            "Where a block is raised: 'response' (as soon as the model emits the call) or "
            "'tool' (only when the framework executes it — for frameworks whose tool-level "
            "patch returns the refusal in-band: LangGraph, CrewAI, AutoGen, LlamaIndex, "
            "smolagents, Pydantic AI)."
        )
    )

    allow_tools: list = Field(
        default_factory=list,
        description=(
            "Tool names that are always allowed, skipping all checks. "
            "Case-insensitive. E.g. ['fetch_page', 'crawl_url']."
        )
    )

    allow_categories: list = Field(
        default_factory=list,
        description=(
            "Tool categories that are always allowed, skipping all checks. "
            "Options: network | file | database | shell | communication | unknown. "
            "E.g. ['network'] to allow all web/crawl tools regardless of name."
        )
    )

    audit_only: bool = Field(
        default=False,
        description=(
            "If True, log everything but never block. "
            "Useful for discovering what AEGIS would block before enabling enforcement."
        )
    )

    class Config:
        use_enum_values = True