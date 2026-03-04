"""OpenTelemetry integration for AgentGuard."""

from typing import Optional

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from agentguard_core_schema import AgentActionTrace

from ..core.config import AgentGuardConfig


class TelemetryService:
    """Service for OpenTelemetry integration."""

    def __init__(self, config: AgentGuardConfig):
        self.config = config
        self.tracer: Optional[trace.Tracer] = None

        if config.enable_telemetry:
            self._initialize_telemetry()

    def _initialize_telemetry(self):
        """Initialize OpenTelemetry."""
        # Create resource
        resource = Resource.create(
            {
                "service.name": "agentguard",
                "service.version": "1.0.0",
                "agent.id": self.config.agent_id,
                "environment": self.config.environment,
            }
        )

        # Create tracer provider
        provider = TracerProvider(resource=resource)

        # Add OTLP exporter if endpoint is configured
        if self.config.otel_endpoint:
            try:
                from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
                otlp_exporter = OTLPSpanExporter(
                    endpoint=self.config.otel_endpoint,
                    headers=self.config.otel_headers,
                )
                processor = BatchSpanProcessor(otlp_exporter)
                provider.add_span_processor(processor)
            except ImportError:
                print("Warning: opentelemetry-exporter-otlp-proto-grpc not installed, OTLP export disabled.")

        # Set global tracer provider
        trace.set_tracer_provider(provider)

        # Get tracer
        self.tracer = trace.get_tracer("agentguard", "1.0.0")

    def record_trace(self, agent_trace: AgentActionTrace):
        """Record a trace as an OpenTelemetry span."""
        if not self.tracer:
            return

        # Create span
        with self.tracer.start_as_current_span(
            name=f"{agent_trace.tool_call.tool_name}.{agent_trace.tool_call.function}",
            attributes={
                "agent.id": str(agent_trace.agent_id),
                "trace.id": str(agent_trace.trace_id),
                "parent.trace.id": str(agent_trace.parent_trace_id)
                if agent_trace.parent_trace_id
                else None,
                "sequence.number": agent_trace.sequence_number,
                "tool.name": agent_trace.tool_call.tool_name,
                "function.name": agent_trace.tool_call.function,
                "duration.ms": agent_trace.observation.duration_ms,
                "has.error": agent_trace.observation.error is not None,
                "risk.level": agent_trace.safety_validation.risk_level
                if agent_trace.safety_validation
                else None,
                "approval.status": agent_trace.approval_status,
                "hash.integrity": agent_trace.integrity_hash,
            },
        ) as span:
            # Add events
            if agent_trace.observation.error:
                span.add_event(
                    "error",
                    attributes={"error.message": agent_trace.observation.error},
                )

            if agent_trace.safety_validation and not agent_trace.safety_validation.passed:
                span.add_event(
                    "safety_violation",
                    attributes={
                        "policy.name": agent_trace.safety_validation.policy_name,
                        "violations": ", ".join(
                            agent_trace.safety_validation.violations or []
                        ),
                    },
                )