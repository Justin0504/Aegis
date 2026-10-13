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

### Where the decision is enforced

`enforce_at="response"` (default): a blocked call raises
`AgentGuardBlockedError` out of the model call, before any tool runs.

`enforce_at="tool"`: the model-level patch only observes and the
framework's tool-level patch (LangGraph, CrewAI, AutoGen, LlamaIndex,
smolagents, Pydantic AI, OpenAI Agents SDK) returns the refusal **as the
tool's result**, so the model sees why and continues instead of failing.
A plain loop, LiteLLM or the Google GenAI client has no method to patch
at the tool; wrap your own dispatcher instead:

```python
agentguard.auto(url, agent_id="ops", blocking_mode=True, enforce_at="tool")
execute_tool = agentguard.guarded(execute_tool)   # fn(tool_name, arguments)
```

`agentguard.check(tool_name, arguments)` / `acheck` is the explicit form
(returns on allow, blocks while a held call awaits a person, raises on
block); `agentguard.refusal(err)` is the in-band text.

Every decision is written into the trace the SDK sends
(`safety_validation`, `approval_status`), and the agent's hash chain
continues across process restarts (the SDK reads
`GET /api/v1/traces/chain-head` before its first trace).

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

### Code Shield — static checks on agent-generated code

```python
from agentguard.integrations.code_shield import scan

result = scan(
    code="exec(user_input)",
    language="python",
    agent_id="my-agent",
    gateway_url="http://localhost:8080",
)
# → {"worst": "CRITICAL", "findings": [...], "rules": ["py.exec"], ...}
```

Sub-millisecond, no LLM round-trip. 19 curated regex rules covering
`eval` / `exec` / `subprocess` / `rm -rf` / hardcoded AWS·OpenAI·Anthropic·GitHub keys / PEM private blocks / dangerous SQL / DOM XSS.

The verdict is also buffered in-process keyed by `agent_id`; the
SDK's auto-instrumentation interceptor reads it on the next `/check`
and splices it under `code_shield.*` so Policy DSL rules like
`{ code_shield.worst: CRITICAL }` fire on the same hop.

### Alignment — does the next tool call serve the declared goal?

For agents whose chain-of-thought you can see, AEGIS audits each
proposed action against a declared goal and tags drift signals.

**LangChain / CrewAI** — drop in a callback, zero extra wiring:

```python
from agentguard.integrations.langchain import AlignmentCallback
executor = AgentExecutor(
    agent=agent, tools=tools,
    callbacks=[AlignmentCallback(
        gateway_url="http://localhost:8080",
        agent_id="my-agent",
        declared_goal="Summarise this week's customer-feedback survey.",
    )],
)
```

```python
from agentguard.integrations.crewai import make_alignment_step_callback
cb = make_alignment_step_callback(
    gateway_url="http://localhost:8080",
    agent_id="my-agent",
    declared_goal="Summarise this week's customer-feedback survey.",
)
researcher = Agent(..., step_callback=cb)
```

**Any other framework** (autogen, pydantic-ai, custom loops) — the
framework-agnostic helper:

```python
from agentguard.integrations.alignment import check

verdict = check(
    agent_id="my-agent",
    declared_goal="Summarise this week's customer-feedback survey.",
    thought_chain=["Thought: I should fetch the survey first."],
    proposed_action={"tool_name": "execute_sql", "arguments": {...}},
    gateway_url="http://localhost:8080",
)
# → {"score": 0.18, "drifted": True, "signals": ["scope-expansion"], ...}
```

Same closed-loop bridge as Code Shield — verdict auto-flows into the
next `/check` payload under `alignment.*`.

### Examples

Runnable scripts in [`examples/`](./examples):

| Script                          | Shows                                                |
| ------------------------------- | ---------------------------------------------------- |
| `quickstart_anthropic.py`       | One-line auto-instrumentation                        |
| `code_shield_scan.py`           | Scan agent-generated code, get severity + findings   |
| `langchain_alignment.py`        | ReAct chain-of-thought audit + closed-loop /check    |
| `custom_agent_alignment.py`     | Framework-agnostic loop using both helpers           |
| `policy_dsl_bootstrap.py`       | Install a Policy DSL from a builtin example          |

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
