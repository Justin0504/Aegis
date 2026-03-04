# AgentGuard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![Node.js](https://img.shields.io/badge/node.js-20+-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](https://www.docker.com/)

**Cryptographic auditing and real-time control for AI agents.**

AgentGuard wraps your AI agent's tool calls with Ed25519-signed audit traces, tamper-proof hash chains, and a live dashboard — giving you full visibility and instant kill-switch control over everything your agents do.

---

## Features

| Capability | Description |
|---|---|
| Cryptographic Audit Trail | Ed25519 signatures + SHA-256 hash chains on every trace |
| Real-time Monitoring | WebSocket-based live dashboard with zero polling |
| Anomaly Detection | Automatic flagging and alerting on dangerous operations |
| Kill Switch | Instant API key revocation on policy violation |
| Policy Engine | Customizable risk-based access control rules |
| Analytics | Comprehensive metrics, latency histograms, and agent insights |
| Time-travel Debugging | Replay and inspect full agent decision chains |
| Enterprise Deployment | Docker, Kubernetes, and cloud-native ready |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        AI Agent                              │
│                    (Your Application)                        │
└────────────────────────┬───────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   AgentGuard SDK                             │
│  • @agent_guard.trace() decorator                           │
│  • Automatic capture & signing                              │
│  • Ed25519 cryptographic signatures                         │
└────────────────────────┬───────────────────────────────────┘
                         │ HTTPS / WebSocket
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Gateway Service                           │
│  • Policy validation & enforcement                          │
│  • Real-time anomaly detection                              │
│  • WebSocket event streaming                                │
└───────┬────────────────┴───────────────┬───────────────────┘
        │                                 │
        ▼                                 ▼
┌───────────────┐                ┌────────────────┐
│   PostgreSQL  │                │   Dashboard    │
│               │◀───────────────│   (Next.js)    │
└───────────────┘                └────────────────┘
```

---

## Quick Start

### Docker (Recommended)

```bash
git clone https://github.com/Justin0504/Aegis.git agentguard
cd agentguard
docker-compose up -d
```

Services available at:
- Dashboard — `http://localhost:3000`
- API — `http://localhost:8080`

### Enhanced Demo

```bash
cd demo/aegis-enhanced
npm install && npm start

# In a second terminal:
python demo_agent.py
```

### Local Development

See [GETTING_STARTED.md](GETTING_STARTED.md) for a full local setup walkthrough.

---

## SDK Usage

### Python

```bash
pip install agentguard-aegis
```

```python
from agentguard import AgentGuard
from agentguard.config import AgentGuardConfig

config = AgentGuardConfig(
    agent_id="my-ai-agent",
    gateway_url="http://localhost:8080",
    enable_signing=True
)
agent_guard = AgentGuard(config)

@agent_guard.trace(tool_name="database_query")
def query_database(sql: str):
    return results
```

### TypeScript / JavaScript (Coming Soon)

```typescript
import { AgentGuard } from '@agentguard/sdk';

const guard = new AgentGuard({
  agentId: 'my-ai-agent',
  gatewayUrl: 'http://localhost:8080'
});

@guard.trace('api_call')
async function callExternalAPI(endpoint: string) {
  // your code here
}
```

---

## Security Model

Every tool call your agent makes is:

1. **Captured** — arguments, outputs, timestamps, and agent identity
2. **Signed** — Ed25519 private key signature bound to the agent
3. **Chained** — SHA-256 hash linking each trace to the previous, making the log tamper-evident
4. **Evaluated** — policy engine scores risk and can block, warn, or terminate

Additional controls: role-based access, automatic API key rotation, and compliance-ready export for GDPR, SOC2, and HIPAA.

---

## Production Deployment

```bash
./deploy-production.sh
```

See [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md) for the full pre-launch checklist.

---

## Testing

```bash
# All tests
npm test

# Python SDK
cd packages/sdk-python && pytest

# Integration
npm run test:integration
```

---

## Documentation

- [Getting Started](GETTING_STARTED.md)
- [API Reference](docs/API.md)
- [Architecture Guide](docs/ARCHITECTURE.md)
- [Security Model](docs/SECURITY.md)
- [Contributing](CONTRIBUTING.md)

---

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](LICENSE).

## Support

- Email: support@agentguard.ai
- Discord: [Join the community](https://discord.gg/agentguard)
- Docs: [docs.agentguard.ai](https://docs.agentguard.ai)
- Issues: [GitHub Issues](https://github.com/Justin0504/Aegis/issues)
