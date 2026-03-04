# @agentguard/core-schema

Shared schemas for the AgentGuard forensic trace format, available in both TypeScript (Zod) and Python (Pydantic).

## Installation

### TypeScript/Node.js
```bash
npm install @agentguard/core-schema
```

### Python
```bash
pip install agentguard-core-schema
```

## Usage

### TypeScript
```typescript
import { AgentActionTraceSchema, calculateTraceHash } from '@agentguard/core-schema';

const trace = AgentActionTraceSchema.parse(traceData);
const hash = calculateTraceHash(trace);
```

### Python
```python
from agentguard_core_schema import AgentActionTrace, calculate_trace_hash

trace = AgentActionTrace(**trace_data)
hash = calculate_trace_hash(trace.model_dump())
```

## Schema Fields

- `trace_id`: Unique identifier for the trace
- `agent_id`: Identifier of the agent that generated the trace
- `timestamp`: When the action occurred
- `input_context`: The prompt and any retrieved context
- `thought_chain`: The agent's reasoning process
- `tool_call`: The tool/function that was invoked
- `observation`: The result of the tool call
- `integrity_hash`: SHA-256 hash for chain integrity
- `safety_validation`: Policy validation results
- `approval_status`: For high-risk operations requiring approval