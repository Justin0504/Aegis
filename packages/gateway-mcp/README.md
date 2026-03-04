# @agentguard/gateway-mcp

MCP (Model Context Protocol) Proxy Gateway for AgentGuard that intercepts, validates, and logs all agent tool calls.

## Features

- **MCP Protocol Support**: Acts as a proxy between agents and tool servers
- **Policy Engine**: JSON Schema-based validation of tool arguments
- **Approval Workflows**: High-risk operations require manual approval
- **Kill Switch**: Automatic API key revocation after repeated violations
- **Audit Trail**: Complete forensic logging with hash chain integrity
- **Real-time Monitoring**: WebSocket connections for live updates

## Installation

```bash
npm install
npm run build
```

## Configuration

Environment variables:

```bash
PORT=8080
DB_PATH=./agentguard.db
MCP_TIMEOUT=30000
DEFAULT_RISK_THRESHOLD=MEDIUM
AUTO_APPROVE_BELOW=LOW
KILL_SWITCH_MAX_VIOLATIONS=3
KILL_SWITCH_WINDOW=3600
```

## Running

```bash
# Development
npm run dev

# Production
npm start
```

## API Endpoints

### Traces
- `POST /api/v1/traces` - Create single trace
- `POST /api/v1/traces/batch` - Batch create traces
- `GET /api/v1/traces` - Query traces
- `GET /api/v1/traces/:traceId` - Get single trace
- `POST /api/v1/traces/export` - Export trace bundle

### Policies
- `GET /api/v1/policies` - List policies
- `POST /api/v1/policies` - Create policy
- `PUT /api/v1/policies/:id/enable` - Enable policy
- `PUT /api/v1/policies/:id/disable` - Disable policy
- `POST /api/v1/policies/test` - Test policy

### Approvals
- `GET /api/v1/approvals/pending` - List pending approvals
- `GET /api/v1/approvals/:id` - Get approval details
- `POST /api/v1/approvals/:id/decision` - Make approval decision
- `GET /api/v1/approvals/stats/:agentId` - Get approval statistics

### MCP WebSocket
- `ws://localhost:8080/mcp` - MCP proxy connection

## Policy Examples

### SQL Injection Prevention
```json
{
  "id": "sql-injection",
  "name": "SQL Injection Prevention",
  "policy_schema": {
    "type": "object",
    "properties": {
      "sql": {
        "type": "string",
        "pattern": "^(?!.*(\\bDROP\\b|\\bDELETE\\b|\\bTRUNCATE\\b)).*$"
      }
    }
  },
  "risk_level": "HIGH"
}
```

### File Access Control
```json
{
  "id": "file-access",
  "name": "File Access Control",
  "policy_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "pattern": "^(?!.*(\\.\\.|~|/etc/|/root/)).*$"
      }
    }
  },
  "risk_level": "MEDIUM"
}
```

## Database Schema

The gateway uses SQLite with the following main tables:
- `traces` - All agent action traces
- `policies` - Safety policies
- `violations` - Policy violations
- `approvals` - Approval requests
- `api_keys` - Agent API keys (for kill switch)