<div align="center">

# AEGIS

**Your AI agent tried to `DELETE` your production database. AEGIS stopped it.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PyPI](https://img.shields.io/badge/PyPI-agentguard--aegis-blue)](https://pypi.org/project/agentguard-aegis/)
[![npm](https://img.shields.io/badge/npm-agentguard-red)](https://www.npmjs.com/package/agentguard)
[![Docker](https://img.shields.io/badge/docker-ready-0db7ed)](https://hub.docker.com/r/agentguard/aegis)

*Pre-execution blocking · Cryptographic audit trail · Human-in-the-loop approvals · Zero code changes*

<!-- demo GIF goes here -->
<!-- ![AEGIS Demo](docs/demo.gif) -->

</div>

---

## 30-second setup

```bash
git clone https://github.com/agentguard/agentguard
cd agentguard
docker compose up -d
```

| Service | URL |
|---------|-----|
| **Compliance Cockpit** (dashboard) | http://localhost:3000 |
| **Gateway API** | http://localhost:8080 |

Then add **one line** to your agent:

```python
import agentguard
agentguard.auto("http://localhost:8080", agent_id="my-agent", blocking_mode=True)

# Everything below is unchanged — AEGIS intercepts automatically
import anthropic
client = anthropic.Anthropic()
response = client.messages.create(model="claude-opus-4-6", tools=[...], messages=[...])
```

That's it. Every tool call is now classified, policy-checked, and logged — before execution.

---

## How it works

```
  Your agent calls a tool
          │
          ▼  (SDK intercepts — zero code changes)
  ┌───────────────────────────────────────────┐
  │  AEGIS Gateway  POST /api/v1/check        │
  │                                           │
  │  ① Classify tool  (SQL? file? network?)   │
  │  ② Match policies (injection? exfil?)     │
  │  ③ Decide: allow / block / pending        │
  └──────────┬────────────────────────────────┘
             │
      ┌──────┴──────────────┐
      │                     │
   allow                 pending ──► Human reviews in dashboard
      │                     │              │
      ▼                     └──── allow ───┘
  Tool executes                        │
      │                             block
      ▼                                │
  Trace signed (Ed25519)               ▼
  Hash-chained (SHA-256)      AgentGuardBlockedError
  Stored in dashboard
```

**The classifier works on any tool name.** No configuration required.

| Tool name | Detected as |
|-----------|-------------|
| `run_query` | `database` (keyword) |
| `execute("SELECT * FROM users")` | `database` (SQL in args) |
| `my_custom_tool(path="/etc/passwd")` | `file` (path in args) |
| `call_api(url="http://...")` | `network` (URL in args) |
| `do_thing(cmd="rm -rf /")` | `shell` (command injection) |

---

## Blocking mode — human in the loop

When an agent attempts a HIGH or CRITICAL risk action, you decide:

```python
agentguard.auto(
    "http://localhost:8080",
    blocking_mode=True,           # hold dangerous calls for human review
    human_approval_timeout_s=300, # auto-block after 5 min with no decision
    poll_interval_s=2.0,
)
```

The agent **pauses and waits**. You see the pending check in the dashboard, review the arguments, and click Allow or Block. The agent resumes instantly.

```python
from agentguard import AgentGuardBlockedError

try:
    response = client.messages.create(...)
except AgentGuardBlockedError as e:
    print(f"Blocked: {e.tool_name} — {e.reason} ({e.risk_level})")
    # Handle gracefully: inform user, log incident, etc.
```

---

## Why AEGIS?

Every other agent observability tool logs what happened. AEGIS can **prove** it — and **stop** it.

|  | LangFuse | Helicone | AEGIS |
|--|----------|----------|-------|
| Observability dashboard | ✅ | ✅ | ✅ |
| **Pre-execution blocking** | ❌ | ❌ | ✅ |
| **Human-in-the-loop approvals** | ❌ | ❌ | ✅ |
| **Auto-classifies any tool name** | ❌ | ❌ | ✅ |
| **Ed25519 signed traces** | ❌ | ❌ | ✅ |
| **SHA-256 tamper-evident chain** | ❌ | ❌ | ✅ |
| **Kill switch** | ❌ | ❌ | ✅ |
| **Forensic PDF export** | ❌ | ❌ | ✅ |
| Self-hostable | ✅ | ❌ | ✅ |

---

## SDK support

**Python** — auto-patches at the SDK level, zero changes to your agent:

```bash
pip install agentguard-aegis
```

| Framework | Auto-patched | Blocking |
|-----------|-------------|---------|
| `anthropic` | ✅ | ✅ |
| `openai` | ✅ | ✅ |
| LangChain / LangGraph | ✅ | ✅ |
| CrewAI | ✅ | ✅ |

**JavaScript / TypeScript:**

```bash
npm install agentguard
```

```typescript
import agentguard from 'agentguard'
agentguard.auto('http://localhost:8080', { agentId: 'my-agent', blockingMode: true })
// existing Anthropic / OpenAI code unchanged
```

---

## Policy engine

Five policies ship by default. The classifier maps **any** tool to a category — so policies apply even when tool names don't match.

| Policy | Risk | Category |
|--------|------|----------|
| SQL Injection Prevention | HIGH | `database` |
| File Access Control | MEDIUM | `file` |
| Network Access Control | MEDIUM | `network` |
| Prompt Injection Detection | CRITICAL | all |
| Data Exfiltration Prevention | HIGH | `network`, `communication` |

Add your own via the dashboard or API:

```bash
curl -X POST http://localhost:8080/api/v1/policies \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "no-prod-deletes",
    "name": "No Production Deletes",
    "risk_level": "CRITICAL",
    "policy_schema": {
      "properties": { "sql": { "not": { "pattern": "DELETE|TRUNCATE" } } }
    }
  }'
```

Override categories for your own tool names:

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

The dashboard gives you full visibility and control:

- **Live trace stream** — every tool call in real time
- **Pending approvals** — one-click allow/block for human-in-the-loop checks
- **Anomaly detection** — automatic flagging of spikes and error bursts
- **Agent comparison** — side-by-side metrics across agents
- **Decision graph** — visual reasoning chain explorer
- **Time-travel debugger** — replay any execution step by step
- **Policy management** — create, toggle, test policies
- **PDF forensic reports** — export tamper-evident audit bundles

---

## Security model

```
Tool call received
  → Pre-execution check   (block before damage, zero tolerance for CRITICAL)
  → Tool executes         (if allowed)
  → Ed25519 signature     (optional, per-agent key)
  → SHA-256 hash chain    (every trace commits to the previous)
  → Kill switch           (3 violations in 24h → auto-revoke)
```

Forensic export — any third party can independently verify the log:

```bash
curl "http://localhost:8080/api/v1/traces?export=bundle" > audit.json
```

---

## Self-hosting

MIT-licensed. No telemetry. No data leaves your infra.

```
packages/
  gateway-mcp/          Node.js gateway (Express + SQLite)
  sdk-python/           pip install agentguard-aegis
  core-schema/          shared TypeScript types

apps/
  compliance-cockpit/   Next.js 14 dashboard
```

**Kubernetes:** Helm chart and manifests in `kubernetes/`
**Production:** `docker compose -f docker-compose.prod.yml up -d` (adds nginx, postgres, redis)
**Monitoring:** OpenTelemetry + Prometheus in `monitoring/`

---

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
git clone https://github.com/agentguard/agentguard
cd agentguard
docker compose -f docker-compose.dev.yml up
```

---

## License

[MIT](LICENSE)
