# AgentGuard Python SDK

High-integrity auditing SDK for AI agents with automatic tracing, cryptographic signing, and safety validation.

## Installation

```bash
pip install agentguard
```

## Quick Start

```python
from agentguard import agent_guard

# Simple usage with decorator
@agent_guard.trace()
def process_user_request(prompt: str):
    # Your agent logic here
    response = llm.complete(prompt)
    return response

# With custom configuration
from agentguard import AgentGuard, AgentGuardConfig

config = AgentGuardConfig(
    agent_id="my-agent-001",
    gateway_url="https://agentguard.mycompany.com",
    enable_signing=True,
    private_key_path="/path/to/private.key",
)

guard = AgentGuard(config)

@guard.trace(tool_name="data_processor")
def process_data(data):
    # Processing logic
    return processed_data
```

## Features

### Automatic Tracing
- Captures function inputs, outputs, and execution time
- Records stdout/stderr output
- Intercepts LLM API calls (OpenAI, Anthropic)

### Cryptographic Security
- Ed25519 signing of all traces
- SHA-256 hash chain for integrity
- Secure key storage with password protection

### Performance
- Asynchronous trace delivery
- Batching for efficiency
- Local fallback storage
- OpenTelemetry integration

### Safety Features
- Integration with MCP Gateway for policy validation
- Support for high-risk operation approval workflows
- Automatic kill-switch on repeated violations

## Configuration

```python
config = AgentGuardConfig(
    # Core settings
    agent_id="unique-agent-id",
    environment="production",  # development, staging, production
    gateway_url="http://localhost:8080",

    # Security
    enable_signing=True,
    private_key_path="/secure/path/private.key",
    private_key_password="optional-password",

    # Performance
    batch_size=100,
    flush_interval_seconds=5.0,
    enable_async=True,

    # Capture settings
    capture_stdout=True,
    capture_stderr=True,
    capture_llm_calls=True,
    capture_exceptions=True,

    # Telemetry
    enable_telemetry=True,
    otel_endpoint="http://localhost:4317",
)
```

## Generating Keys

```python
from agentguard.crypto import generate_and_save_keypair

# Generate new Ed25519 keypair
private_key, public_key_path = generate_and_save_keypair(
    path="/secure/location/agent.key",
    password="strong-password"  # Optional
)
```

## Advanced Usage

### Context Management

```python
# Manually manage trace context
with guard._create_trace_context() as ctx:
    # Your code here
    pass
```

### Custom Interceptors

```python
# Add custom LLM provider
class CustomLLMInterceptor:
    def patch_custom_llm(self):
        # Your patching logic
        pass

# Register with AgentGuard
guard._llm_interceptor = CustomLLMInterceptor()
```

## License

See LICENSE file in the root directory.