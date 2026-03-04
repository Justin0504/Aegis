# Getting Started with AgentGuard

## Prerequisites

- Docker and Docker Compose
- Python 3.10+ (for SDK usage)
- Node.js 20+ (for local development without Docker)

---

## Option 1: Docker (Recommended)

The fastest way to get everything running.

```bash
git clone https://github.com/Justin0504/Aegis.git agentguard
cd agentguard

cp .env.example .env   # edit values if needed

docker-compose up -d
```

Services:
- Dashboard — `http://localhost:3000`
- API Gateway — `http://localhost:8080`

---

## Option 2: Local Development (hot-reload)

```bash
git clone https://github.com/Justin0504/Aegis.git agentguard
cd agentguard

cp .env.example .env

make dev
```

Additional services in dev mode:
- Database UI (Adminer) — `http://localhost:8081`
- Redis UI — `http://localhost:8082`

---

## Python SDK

```bash
pip install agentguard-core-schema agentguard-aegis
```

For local development from source:

```bash
make install-sdk
```

### Basic usage

```python
from agentguard import AgentGuard, AgentGuardConfig

config = AgentGuardConfig(
    agent_id="my-agent",
    gateway_url="http://localhost:8080",
    enable_signing=False  # set True once you have a keypair
)
guard = AgentGuard(config)

@guard.trace(tool_name="my_tool")
def my_tool(query: str):
    return "result"
```

### Generating an Ed25519 keypair (optional, for signed traces)

```python
from agentguard.crypto import generate_and_save_keypair

generate_and_save_keypair("./agent.key")
```

Then set `private_key_path="./agent.key"` and `enable_signing=True` in your config.

---

## Defining Safety Policies

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

---

## Monitoring

Open `http://localhost:3000` and navigate to the Traces tab. Each trace shows:

- Input arguments and output
- Cryptographic signature status
- Policy evaluation result
- Position in the hash chain

The Decision Graph view (ReactFlow) visualises the agent's full reasoning flow. Red nodes indicate policy violations.

---

## Violation Handling

1. First violation — request blocked, error returned to agent
2. After 3 violations within the configured window — API key revoked (kill switch)
3. Recovery — admin must manually reinstate access from the dashboard

---

## Exporting Audit Traces

```bash
curl http://localhost:8080/api/v1/traces/export \
  -d '{"agent_id": "my-agent", "start_time": "2024-01-01T00:00:00Z"}'
```

Verify the hash chain:

```python
from agentguard_core_schema import validate_trace_chain
import json

bundle = json.load(open("trace-bundle.json"))
print("Valid:", validate_trace_chain(bundle["traces"]))
```

---

## Production Deployment

```bash
./deploy-production.sh
```

See [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md) before going live.

---

## Makefile Reference

| Command | Description |
|---|---|
| `make up` | Start all services (production) |
| `make dev` | Start all services (dev, hot-reload) |
| `make down` | Stop all services |
| `make logs` | Tail logs |
| `make install-sdk` | Install Python SDK locally |
| `make clean` | Remove all containers and volumes |
| `make db-backup` | Backup SQLite database |

---

## License

[MIT](./LICENSE)
