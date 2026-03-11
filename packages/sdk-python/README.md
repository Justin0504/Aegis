# AgentGuard Python SDK

Python SDK for AEGIS tracing, pre-execution checks, and auto-instrumentation.

## Installation

```bash
pip install agentguard-aegis
```

## Quick Start

### Decorator-based tracing

```python
import agentguard


@agentguard.trace(tool_name="process_user_request")
def process_user_request(prompt: str):
    return {"ok": True, "prompt": prompt}
```

### Configured guard instance

```python
from agentguard import AgentGuard, AgentGuardConfig

guard = AgentGuard(AgentGuardConfig(
    agent_id="my-agent-001",
    gateway_url="http://localhost:8080",
    enable_signing=True,
    private_key_path="/path/to/private.key",
))


@guard.trace(tool_name="data_processor")
def process_data(data):
    return {"processed": True, "items": len(data)}
```

### Auto-instrument supported SDKs

```python
import agentguard

agentguard.auto(
    "http://localhost:8080",
    agent_id="my-agent",
    blocking_mode=True,
)

# Existing Anthropic / OpenAI / supported SDK usage can remain unchanged
```

## Features

### Tracing
- Decorator-based tracing for Python functions and tools
- Trace transport to the AEGIS gateway
- Hash-chained audit records
- Optional Ed25519 signing when configured

### Auto-instrumentation
- Anthropic
- OpenAI
- LangGraph
- CrewAI
- Gemini
- Bedrock
- Mistral
- LlamaIndex
- smolagents

### Safety Controls
- Pre-execution policy checks via `/api/v1/check`
- Blocking mode with human approval polling
- Allow-lists, thresholds, and audit-only mode

## Configuration

```python
from agentguard import AgentGuardConfig

config = AgentGuardConfig(
    agent_id="unique-agent-id",
    gateway_url="http://localhost:8080",
    environment="PRODUCTION",
    enable_signing=True,
    private_key_path="/secure/path/private.key",
    blocking_mode=True,
    block_threshold="HIGH",
    human_approval_timeout_s=300,
    fail_open=True,
    enable_telemetry=True,
)
```

## Generating Keys

```python
from pathlib import Path
from agentguard.crypto import generate_keypair, save_private_key

private_key = generate_keypair()
public_key_path = save_private_key(
    private_key,
    Path("/secure/location/agent.key"),
    password="strong-password",
)
```

## Useful Entry Points

```python
import agentguard

agentguard.trace(...)
agentguard.auto(...)
agentguard.patch(...)
agentguard.dev(...)
agentguard.watch(locals())
agentguard.wrap_tools({"search": search_tool})
```

## License

See the root `LICENSE` file.
