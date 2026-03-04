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

    class Config:
        use_enum_values = True