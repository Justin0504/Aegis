# Getting Started with AEGIS

## Quick Start (Docker)

```bash
git clone https://github.com/Justin0504/Aegis.git && cd Aegis
./setup.sh
```

That's it. Open:
- **Dashboard** — http://localhost:3000
- **Gateway API** — http://localhost:8080

### Stop / restart

```bash
docker compose down        # stop
docker compose up -d       # restart
docker compose logs -f     # view logs
```

---

## Development (hot-reload)

```bash
make dev
```

Source changes in `packages/gateway-mcp/src` and `apps/compliance-cockpit/src` are picked up automatically.

---

## Python SDK

```bash
pip install agentguard-aegis
```

Or from source:

```bash
make install-sdk
```

### Usage

```python
from agentguard import AgentGuard, AgentGuardConfig

guard = AgentGuard(AgentGuardConfig(
    agent_id="my-agent",
    gateway_url="http://localhost:8080",
))

@guard.trace(tool_name="my_tool")
def my_tool(query: str):
    return "result"
```

---

## Claude Code Integration

```bash
npm install -g agentguard   # if not already installed
agentguard claude-code setup --gateway http://localhost:8080
```

This configures Claude Code to send all tool calls through AEGIS for auditing and policy enforcement.

---

## Safety Policies

```bash
curl -X POST http://localhost:8080/api/v1/policies \
  -H "Content-Type: application/json" \
  -d '{
    "id": "no-delete",
    "name": "Prevent Deletions",
    "policy_schema": {
      "type": "object",
      "properties": {
        "action": { "type": "string", "not": { "pattern": "^(delete|remove|drop)" } }
      }
    },
    "risk_level": "HIGH"
  }'
```

---

## Makefile Reference

| Command | Description |
|---------|-------------|
| `make up` | Start services |
| `make down` | Stop services |
| `make dev` | Start with hot-reload |
| `make logs` | Tail logs |
| `make clean` | Remove containers and volumes |
| `make install-sdk` | Install Python SDK locally |

---

## Next reads

By role — pick your lane:

| I'm a… | Start here |
|---|---|
| **Developer** integrating the SDK | [`packages/sdk-python/README.md`](./packages/sdk-python/README.md) · [`packages/sdk-js/README.md`](./packages/sdk-js/README.md) |
| **Operator** deploying + running it | [`docs/OPERATIONS.md`](./docs/OPERATIONS.md) — health checks, Prometheus + Grafana, rollback runbook, replay, rate limits |
| **Architect** trying to understand the design | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — components, data flow, reversibility model, prior art |
| **Contributor** making a PR | [`CONTRIBUTING.md`](./CONTRIBUTING.md) · [`docs/TESTING.md`](./docs/TESTING.md) — 4 harnesses, `npm run test:*` matrix |
| **Compliance officer** doing an audit | [`SECURITY.md`](./SECURITY.md) · [`docs/OPERATIONS.md`](./docs/OPERATIONS.md#observability) · transparency log |
| **Prospect** deciding whether to adopt | [aegistraces.com/docs](https://aegistraces.com/docs) · [`PERFORMANCE.md`](./PERFORMANCE.md) · [`COMMERCIAL.md`](./COMMERCIAL.md) |
