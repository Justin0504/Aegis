<div align="center">

# AEGIS

**Your AI agent tried to `DROP TABLE users`. AEGIS stopped it.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PyPI](https://img.shields.io/pypi/v/agentguard-aegis?label=PyPI&color=blue)](https://pypi.org/project/agentguard-aegis/)
[![npm](https://img.shields.io/badge/npm-%40justinnn%2Fagentguard-red)](https://www.npmjs.com/package/@justinnn/agentguard)
[![Docker](https://img.shields.io/badge/ghcr.io-aegis--gateway-0db7ed)](https://github.com/Justin0504/Aegis/pkgs/container/aegis-gateway)

*Pre-execution blocking · Human-in-the-loop approvals · Cryptographic audit trail · 9 frameworks · Zero code changes*

</div>

---

## The problem

AI agents are powerful and unpredictable. They can:

- Delete your database because a prompt said "clean up old records"
- Exfiltrate gigabytes of data because "the user asked for a report"
- Execute arbitrary shell commands because the model hallucinated a tool name

Logging what happened is not enough. You need to **stop it before it happens**.

---

## 30-second setup

```bash
git clone https://github.com/Justin0504/Aegis
cd Aegis
docker compose up -d
```

| Service | URL |
|---------|-----|
| **Compliance Cockpit** | http://localhost:3000 |
| **Gateway API** | http://localhost:8080 |

Then add **one line** to your agent:

```python
import agentguard
agentguard.auto("http://localhost:8080", agent_id="my-agent")

# Everything below is unchanged — no decorators, no wrappers
import anthropic
client = anthropic.Anthropic()
response = client.messages.create(model="claude-opus-4-6", tools=[...], messages=[...])
```

Or **zero lines** with an env var:

```bash
AGENTGUARD_URL=http://localhost:8080 python your_agent.py
```

That's it. Every tool call is now classified, policy-checked, cryptographically signed, and logged — before execution.

---

## How it works

```
  Your agent calls a tool
          │
          ▼  (SDK intercepts at the LLM response level)
  ┌────────────────────────────────────────────────┐
  │  AEGIS Gateway                                 │
  │                                                │
  │  ① Classify tool   (SQL? file? network? shell?) │
  │  ② Match policies  (injection? exfil? traversal?)│
  │  ③ Decide: allow / block / pending             │
  └──────────┬─────────────────────────────────────┘
             │
      ┌───────┴──────────────┐
      │                      │
   allow                  pending ──► Human reviews in dashboard
      │                      │               │
      ▼                      └──── allow ────┘
  Tool executes                         │
      │                              block
      ▼                                 │
  Signed (Ed25519)                      ▼
  Hash-chained (SHA-256)      AgentGuardBlockedError
  Stored in dashboard
```

**The classifier works on any tool name — zero configuration required.**

| Tool called | Detected as | Why |
|-------------|-------------|-----|
| `run_query(sql="SELECT...")` | `database` | SQL keyword in args |
| `my_tool(path="/etc/passwd")` | `file` | sensitive path |
| `do_thing(url="http://...")` | `network` | URL in args |
| `helper(cmd="rm -rf /")` | `shell` | command injection signal |
| `custom_fn(prompt="ignore previous...")` | all | prompt injection |

---

## Blocking mode

When your agent attempts a HIGH or CRITICAL risk action, **it pauses**. You decide.

```python
agentguard.auto(
    "http://localhost:8080",
    blocking_mode=True,            # hold dangerous calls for review
    human_approval_timeout_s=300,  # auto-block after 5 min with no decision
)
```

The agent waits. You open the dashboard, see the exact arguments it was about to use, and click **Allow** or **Block**. The agent resumes in under a second.

```python
from agentguard import AgentGuardBlockedError

try:
    response = client.messages.create(...)
except AgentGuardBlockedError as e:
    print(f"Blocked: {e.tool_name} — {e.reason} ({e.risk_level})")
```

---

## Why AEGIS over the alternatives?

Every other agent observability tool tells you **what happened**. AEGIS **prevents it**.

|  | LangFuse | Helicone | Arize | AEGIS |
|--|----------|----------|-------|-------|
| Observability dashboard | ✅ | ✅ | ✅ | ✅ |
| **Pre-execution blocking** | ❌ | ❌ | ❌ | ✅ |
| **Human-in-the-loop approvals** | ❌ | ❌ | ❌ | ✅ |
| **Auto-classifies any tool name** | ❌ | ❌ | ❌ | ✅ |
| **Ed25519 signed audit trail** | ❌ | ❌ | ❌ | ✅ |
| **SHA-256 tamper-evident chain** | ❌ | ❌ | ❌ | ✅ |
| **Kill switch** | ❌ | ❌ | ❌ | ✅ |
| **Natural language policy editor** | ❌ | ❌ | ❌ | ✅ |
| **Claude Desktop MCP integration** | ❌ | ❌ | ❌ | ✅ |
| **Slack / PagerDuty alerts** | ❌ | ❌ | ❌ | ✅ |
| Self-hostable | ✅ | ❌ | ❌ | ✅ |

---

## SDK support — 9 frameworks, zero code changes

```bash
pip install agentguard-aegis
```

| Framework | Status |
|-----------|--------|
| Anthropic | ✅ auto-patched |
| OpenAI | ✅ auto-patched |
| LangChain / LangGraph | ✅ auto-patched |
| CrewAI | ✅ auto-patched |
| Google Gemini | ✅ auto-patched |
| AWS Bedrock | ✅ auto-patched |
| Mistral | ✅ auto-patched |
| LlamaIndex | ✅ auto-patched |
| smolagents | ✅ auto-patched |

**JavaScript / TypeScript:**

```bash
npm install @justinnn/agentguard
```

```typescript
import agentguard from '@justinnn/agentguard'
agentguard.auto('http://localhost:8080', { agentId: 'my-agent', blockingMode: true })
// existing Anthropic / OpenAI / LangChain code unchanged
```

**Go:**

```bash
go get github.com/Justin0504/Aegis/packages/sdk-go@latest
```

```go
import agentguard "github.com/Justin0504/Aegis/packages/sdk-go"

guard := agentguard.Auto() // reads AGENTGUARD_URL, AGENTGUARD_AGENT_ID env vars
defer guard.Close()

result, err := guard.Wrap("query_db", args, func() (any, error) {
    return db.Query("SELECT ...")
})

var blocked *agentguard.BlockedError
if errors.As(err, &blocked) {
    log.Printf("Blocked: %s — %s", blocked.ToolName, blocked.Reason)
}
```

Zero external dependencies. Standard library only.

---

## OpenTelemetry export

Every AEGIS trace can be forwarded as an OTEL span to Datadog, Grafana, Jaeger, or any OTLP-compatible collector:

```bash
OTEL_ENABLED=true \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=aegis-gateway \
node dist/server.js
```

Each span is named `tool_call/<tool_name>` and carries these attributes:

| Attribute | Value |
|-----------|-------|
| `aegis.agent_id` | agent identifier |
| `aegis.tool_name` | tool being called |
| `aegis.risk_level` | LOW / MEDIUM / HIGH / CRITICAL |
| `aegis.blocked` | true if the call was blocked |
| `aegis.cost_usd` | estimated LLM cost |
| `aegis.pii_detected` | 1 if PII was found in arguments |

OTEL errors are silently ignored — they never break your agent's execution path.

---

## Policy engine

Five policies ship by default. **Any** tool gets classified — no configuration needed.

| Policy | Risk | Blocks |
|--------|------|--------|
| SQL Injection Prevention | HIGH | `DROP`, `DELETE`, `TRUNCATE` in DB tools |
| File Access Control | MEDIUM | path traversal, `/etc/`, `/root/` |
| Network Access Control | MEDIUM | HTTP (non-HTTPS) requests |
| Prompt Injection Detection | CRITICAL | "ignore previous instructions" patterns |
| Data Exfiltration Prevention | HIGH | large payloads to external endpoints |

**Write policies in plain English** — the AI assistant converts them automatically:

> *"Block all file deletions outside the /tmp directory"*
> → Generates JSON schema + risk level + description instantly

Or write them manually via the dashboard or API:

```bash
curl -X POST http://localhost:8080/api/v1/policies \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: YOUR_KEY' \
  -d '{
    "id": "no-prod-deletes",
    "name": "No Production Deletes",
    "risk_level": "CRITICAL",
    "policy_schema": {
      "properties": { "sql": { "not": { "pattern": "DELETE|TRUNCATE" } } }
    }
  }'
```

Map your own tool names to categories:

```python
agentguard.auto(
    "http://localhost:8080",
    tool_categories={
        "my_query_runner": "database",
        "send_email":      "communication",
        "s3_upload":       "network",
    }
)
```

---

## Compliance Cockpit

Real-time visibility and control over every agent action:

- **Live trace stream** — every tool call as it happens, with risk level and classification
- **Pending approvals** — one-click allow/block for human-in-the-loop checks
- **Agent behavior baseline** — 7-day profile per agent: top tools, risk distribution, PII rate
- **Anomaly detection** — automatic flagging of spikes, error bursts, unusual patterns
- **Cost tracking** — token usage and USD cost per agent, per session, per tool
- **PII detection** — automatic redaction of sensitive data in traces
- **Alert rules** — threshold-based alerts with Slack, PagerDuty, or webhook delivery
- **Forensic export** — PDF compliance reports and CSV audit bundles
- **Policy editor** — create and toggle policies, with AI-assisted generation
- **Kill switch** — manual or automatic agent revocation after N violations

---

## Claude Desktop integration (MCP)

AEGIS exposes its audit data as MCP tools. Ask Claude about your agents directly:

```json
{
  "mcpServers": {
    "aegis": {
      "url": "ws://localhost:8080/mcp-audit"
    }
  }
}
```

Available tools: `query_traces`, `list_violations`, `get_agent_stats`, `list_policies`

> *"What did agent X do in the last hour?"* → Claude queries AEGIS and tells you.

---

## Security model

```
Tool call received
  → Pre-execution check      (block before damage — zero tolerance for CRITICAL)
  → Tool executes            (if allowed)
  → Ed25519 signature        (optional, per-agent keypair)
  → SHA-256 hash chain       (each trace commits to the previous)
  → Kill switch              (3 violations in 1h → auto-revoke)
  → Immutable audit log      (cryptographically verifiable by any third party)
```

Gateway API is protected by an auto-generated API key — management endpoints require authentication, SDK ingest endpoints remain open so agents work without configuration.

---

## Precision controls

Not everything needs to be blocked. Fine-tune with:

```python
agentguard.auto(
    "http://localhost:8080",
    block_threshold="HIGH",          # only block HIGH and CRITICAL (default)
    allow_tools=["read_file"],       # always allow these specific tools
    allow_categories=["network"],    # always allow all network tools
    audit_only=True,                 # log everything, block nothing
)
```

---

## Self-hosting

MIT-licensed. No telemetry. No data leaves your infrastructure.

```
packages/
  gateway-mcp/          Node.js gateway (Express + SQLite)
  sdk-python/           pip install agentguard-aegis
  sdk-js/               npm install @justinnn/agentguard
  sdk-go/               go get github.com/Justin0504/Aegis/packages/sdk-go
  core-schema/          shared TypeScript types

apps/
  compliance-cockpit/   Next.js dashboard
```

**Docker Compose (recommended):**
```bash
docker compose up -d
```

---

## Contributing

Issues and PRs welcome.

```bash
git clone https://github.com/Justin0504/Aegis
cd Aegis
docker compose -f docker-compose.dev.yml up
```

---

## License

[MIT](LICENSE)
