# AgentGuard 🛡️

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![Node.js](https://img.shields.io/badge/node.js-20+-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](https://www.docker.com/)

A high-integrity auditing system for AI agents with cryptographic verification, real-time monitoring, and compliance visualization.

## 🌟 Features

- **🔐 Cryptographic Audit Trail**: Ed25519 signatures with SHA-256 hash chains
- **📊 Real-time Monitoring**: WebSocket-based live dashboard
- **🚨 Anomaly Detection**: Automatic detection and alerting of dangerous operations
- **⚡ Kill Switch**: Instant API key revocation on policy violations
- **🎯 Policy Engine**: Customizable risk-based access control
- **📈 Advanced Analytics**: Comprehensive metrics and insights
- **🔍 Time-travel Debugging**: Replay and analyze agent decision chains
- **🏗️ Enterprise Ready**: Docker, Kubernetes, and cloud-native deployment

## 🏗️ Architecture

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
                         │ HTTPS/WebSocket
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
│   Database    │                │   Dashboard    │
│  (PostgreSQL) │◀───────────────│   (Next.js)    │
└───────────────┘                └────────────────┘
```

## 🚀 Quick Start

### Option 1: Docker (Recommended)

```bash
# Clone the repository
git clone https://github.com/Justin0504/Aegis.git agentguard
cd agentguard

# Start with Docker Compose
docker-compose up -d

# Access services
# Dashboard: http://localhost:3000
# API: http://localhost:8080
```

### Option 2: Enhanced Demo

```bash
cd demo/aegis-enhanced
npm install
npm start

# In another terminal
python demo_agent.py
```

### Option 3: Local Development

See [GETTING_STARTED.md](GETTING_STARTED.md) for detailed setup instructions.

## 💻 SDK Usage

### Python

```python
from agentguard import AgentGuard
from agentguard.config import AgentGuardConfig

# Initialize
config = AgentGuardConfig(
    agent_id="my-ai-agent",
    gateway_url="http://localhost:8080",
    enable_signing=True
)
agent_guard = AgentGuard(config)

# Trace any function
@agent_guard.trace(tool_name="database_query")
def query_database(sql: str):
    # Your code here
    return results
```

### TypeScript/JavaScript (Coming Soon)

```typescript
import { AgentGuard } from '@agentguard/sdk';

const guard = new AgentGuard({
  agentId: 'my-ai-agent',
  gatewayUrl: 'http://localhost:8080'
});

@guard.trace('api_call')
async function callExternalAPI(endpoint: string) {
  // Your code here
}
```

## 📊 Dashboard Features

- **Real-time Monitoring**: Live trace updates via WebSocket
- **Anomaly Detection**: Automatic flagging of suspicious operations
- **Agent Management**: Track and control multiple AI agents
- **Policy Configuration**: Define and enforce security policies
- **Metrics & Analytics**: Comprehensive performance insights
- **Audit Logs**: Immutable, cryptographically signed records

## 🔒 Security Features

- **Ed25519 Digital Signatures**: Every trace is cryptographically signed
- **Hash Chain Integrity**: Tamper-proof linked audit trail
- **Role-based Access Control**: Fine-grained permissions
- **API Key Rotation**: Automatic key management
- **Kill Switch**: Emergency agent termination
- **Compliance Ready**: GDPR, SOC2, HIPAA compatible

## 🚀 Production Deployment

For production deployment, see [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md).

```bash
# Quick production setup
./deploy-production.sh
```

## 📖 Documentation

- [Getting Started](GETTING_STARTED.md)
- [API Reference](docs/API.md)
- [Architecture Guide](docs/ARCHITECTURE.md)
- [Security Model](docs/SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## 🧪 Testing

```bash
# Run all tests
npm test

# Python SDK tests
cd packages/sdk-python
pytest

# Integration tests
npm run test:integration
```

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

Built with ❤️ for the AI safety community.

## 📞 Support

- 📧 Email: support@agentguard.ai
- 💬 Discord: [Join our community](https://discord.gg/agentguard)
- 📚 Documentation: [docs.agentguard.ai](https://docs.agentguard.ai)
- 🐛 Issues: [GitHub Issues](https://github.com/Justin0504/Aegis/issues)