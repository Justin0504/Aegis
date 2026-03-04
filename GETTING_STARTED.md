# Getting Started with AgentGuard

## 🚀 Quick Start (Docker)

```bash
# Clone the repository
cd agentguard

# Copy environment variables
cp .env.example .env

# Start all services in development mode
make dev

# Access the services:
# - Dashboard: http://localhost:3000
# - API Gateway: http://localhost:8080
# - Database UI: http://localhost:8081
```

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        AI Agent                              │
│                    (Your Application)                        │
└────────────────────────┬───────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   AgentGuard SDK                             │
│                  (@agentguard/sdk)                           │
│  • @agent_guard.trace() decorator                           │
│  • Automatic capture & signing                              │
│  • Ed25519 cryptographic signatures                         │
└────────────────────────┬───────────────────────────────────┘
                         │ HTTPS
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    MCP Gateway                               │
│               (@agentguard/gateway-mcp)                      │
│  • Policy validation                                         │
│  • Approval workflows                                        │
│  • Kill switch mechanism                                     │
└───────┬────────────────┴───────────────┬───────────────────┘
        │                                 │
        ▼                                 ▼
┌───────────────┐                ┌────────────────┐
│    SQLite     │                │  Compliance    │
│   Database    │◀───────────────│    Cockpit     │
│               │                 │   (Next.js)    │
└───────────────┘                └────────────────┘
```

## 📦 Components

### 1. Core Schema (`/packages/core-schema`)
Shared data models in TypeScript (Zod) and Python (Pydantic):
- `AgentActionTrace`: Main trace object with hash chain
- `SafetyValidation`: Policy validation results
- `TraceBundle`: Cryptographically signed export format

### 2. Python SDK (`/packages/sdk-python`)
```python
from agentguard import agent_guard

@agent_guard.trace()
def risky_operation(query: str):
    # Your code here
    return result
```

### 3. MCP Gateway (`/packages/gateway-mcp`)
- WebSocket proxy for Model Context Protocol
- JSON Schema policy engine
- Automatic API key revocation after violations

### 4. Compliance Cockpit (`/apps/compliance-cockpit`)
- Real-time dashboard
- Decision graph visualization (ReactFlow)
- Time-travel debugger
- Evidence export

## 🔧 Development Setup

### Prerequisites
- Node.js 20+
- Python 3.10+
- Docker & Docker Compose

### Local Development
```bash
# Install dependencies
npm install

# Generate Python SDK keypair
cd packages/sdk-python
python -c "from agentguard.crypto import generate_and_save_keypair; generate_and_save_keypair('./agent.key')"

# Start gateway
npm run dev --workspace=@agentguard/gateway-mcp

# Start dashboard (new terminal)
npm run dev --workspace=@agentguard/compliance-cockpit

# Install Python SDK
pip install -e ./packages/sdk-python
```

## 🔐 Security Setup

### 1. Generate Agent Keys
```python
from agentguard.crypto import generate_and_save_keypair
private_key, public_key_path = generate_and_save_keypair(
    path="./agent.key",
    password="strong-password"  # Optional
)
```

### 2. Configure SDK
```python
from agentguard import AgentGuard, AgentGuardConfig

config = AgentGuardConfig(
    agent_id="prod-agent-001",
    gateway_url="https://agentguard.company.com",
    private_key_path="./agent.key",
    environment="PRODUCTION"
)

agent_guard = AgentGuard(config)
```

### 3. Define Safety Policies
```bash
curl -X POST http://localhost:8080/api/v1/policies \
  -H "Content-Type: application/json" \
  -d '{
    "id": "no-delete",
    "name": "Prevent Deletions",
    "policy_schema": {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "not": { "pattern": "^(delete|remove|drop)" }
        }
      }
    },
    "risk_level": "HIGH"
  }'
```

## 📊 Monitoring

### View Traces
1. Open http://localhost:3000
2. Navigate to Traces tab
3. Click on any trace for details

### Decision Graph
- Shows agent reasoning flow
- Red nodes = policy violations
- Green nodes = approved actions

### Time Travel Debugger
- Replay agent execution step-by-step
- View state at any point in time

## 🚨 Handling Violations

When an agent violates policies:

1. **Immediate**: Request blocked, error returned
2. **After 3 violations**: Agent API key revoked (kill switch)
3. **Recovery**: Admin must manually reinstate access

## 📤 Exporting Evidence

```bash
# Export trace bundle
curl http://localhost:8080/api/v1/traces/export \
  -d '{"agent_id": "agent-001", "start_time": "2024-01-01T00:00:00Z"}'

# Verify hash chain
python -c "
from agentguard_core_schema import validate_trace_chain
import json
bundle = json.load(open('trace-bundle.json'))
print('Valid:', validate_trace_chain(bundle['traces']))
"
```

## 🌐 Production Deployment

```bash
# Build for production
make build

# Deploy with Docker Compose
make prod

# Or deploy to Kubernetes
helm install agentguard ./charts/agentguard
```

## 📚 Next Steps

1. **Integrate SDK**: Add `@agent_guard.trace()` to your agent code
2. **Define Policies**: Create safety rules for your use case
3. **Monitor Dashboard**: Watch real-time agent activity
4. **Set Alerts**: Configure notifications for violations
5. **Train Team**: Review approval workflows

## 🤝 Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

## 📄 License

[MIT License](./LICENSE)