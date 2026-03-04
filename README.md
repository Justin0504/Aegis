# AgentGuard: AI Agent Auditing System

A high-integrity "Black Box" auditing system for AI Agents with cryptographic audit trails and compliance visualization.

## 🏗️ Architecture

```
agentguard/
├── packages/
│   ├── sdk-python/       # Python SDK for agent developers
│   ├── gateway-mcp/      # MCP Proxy Gateway (Node.js/TypeScript)
│   └── core-schema/      # Shared schemas (Pydantic/Zod)
├── apps/
│   └── compliance-cockpit/ # Next.js 14 Dashboard
└── docker/               # Docker configurations
```

## 🚀 Quick Start

### Prerequisites
- Node.js 20+
- Python 3.10+
- Docker & Docker Compose

### Demo Options

1. **Basic Demo** - Simple HTTP-based monitoring in `/demo`
2. **Enhanced Demo** - Advanced Notion-style dashboard with real-time WebSocket monitoring in `/demo/aegis-enhanced`

For the enhanced experience:
```bash
cd demo/aegis-enhanced
npm install
npm start
# Visit http://localhost:8080
```

### Setup
```bash
# Install dependencies
npm install

# Setup Python SDK
cd packages/sdk-python
python -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows
pip install -e .

# Start development servers
npm run dev
```

### Docker Deployment
```bash
npm run docker:build
npm run docker:up
```

## 🔐 Key Features

- **Forensic Trace Schema**: Cryptographically signed audit trail with hash-chain integrity
- **Interceptor SDK**: Python decorator for automatic tracing
- **MCP Proxy Gateway**: Safety policy validation and approval workflows
- **Compliance Dashboard**: Real-time visualization and time-travel debugging
- **Kill Switch**: Automatic API key revocation on policy violations

## 📚 Documentation

See `/docs` for detailed API documentation and integration guides.