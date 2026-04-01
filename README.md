<div align="center">

# AEGIS

### The firewall for AI agents.

**Every tool call. Intercepted. Classified. Blocked — before it executes.**

<br>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PyPI](https://img.shields.io/pypi/v/agentguard-aegis?label=PyPI&color=blue)](https://pypi.org/project/agentguard-aegis/)
[![npm](https://img.shields.io/badge/npm-%40justinnn%2Fagentguard-red)](https://www.npmjs.com/package/@justinnn/agentguard)
[![Docker](https://img.shields.io/badge/ghcr.io-aegis--gateway-0db7ed)](https://github.com/Justin0504/Aegis/pkgs/container/aegis-gateway)
[![CI](https://github.com/Justin0504/Aegis/actions/workflows/ci.yml/badge.svg)](https://github.com/Justin0504/Aegis/actions)
[![arXiv](https://img.shields.io/badge/arXiv-2603.12621-b31b1b.svg)](https://arxiv.org/abs/2603.12621)

</div>

<br>

> Your agent just called `DROP TABLE users` because the prompt said "clean up old records."
>
> Your agent just exfiltrated 2GB because "the user asked for a report."
>
> Your agent just ran `rm -rf /` because the model hallucinated a tool name.
>
> **These are not hypotheticals.** Every agent framework lets AI decide which tools to call, with what arguments, at machine speed. There is no human in the loop. There is no undo button.
>
> AEGIS is the missing layer: a **pre-execution firewall** that sits between your agent and its tools, classifies every call in real time, enforces policies, blocks violations, and creates a tamper-evident audit trail with hash chaining and optional signing support — all with **one line of code and zero changes to your agent.**

<br>

<div align="center">
<img src="docs/images/dashboard-overview.png" alt="AEGIS Compliance Cockpit" width="820">
<br>
<sub>The AEGIS Compliance Cockpit — real-time monitoring across all your agents.</sub>
</div>

---

## Demo

<div align="center">

**A real Claude-powered research assistant, fully integrated with AEGIS.**<br>
Watch it trace tool calls, block SQL injection, detect PII, and pause for human approval — live.

<img src="docs/images/readme_demo2.gif" alt="Live agent demo" width="820">

<br>

**The Compliance Cockpit: traces, policies, cost tracking, sessions, approvals.**

<img src="docs/images/readme_demo1.gif" alt="Dashboard walkthrough" width="820">

</div>

---

## Quick Start

**3 commands. 30 seconds. Full protection.**

```bash
git clone https://github.com/Justin0504/Aegis
cd Aegis
docker compose up -d
```

| Service | URL | What it does |
|---------|-----|--------------|
| **Compliance Cockpit** | [localhost:3000](http://localhost:3000) | Dashboard — traces, policies, approvals, costs |
| **Gateway API** | [localhost:8080](http://localhost:8080) | Policy engine — classifies, checks, blocks |

Then add **one line** to your agent:

```python
import agentguard
agentguard.auto("http://localhost:8080", agent_id="my-agent")

# Your existing code — completely unchanged
import anthropic
client = anthropic.Anthropic()
response = client.messages.create(model="claude-sonnet-4-20250514", tools=[...], messages=[...])
```

For supported Python integrations, importing `agentguard` once is enough to enable auto-instrumentation:

```bash
python -c "import agentguard; agentguard.auto('http://localhost:8080', agent_id='my-agent')"
```

That's it. Every tool call is now classified, policy-checked, and recorded in a tamper-evident audit trail **before** execution.

---

## Why AEGIS?

Every agent observability tool (LangFuse, Helicone, Arize) tells you **what happened**. AEGIS **prevents it from happening.**

|  | LangFuse | Helicone | Arize | **AEGIS** |
|--|----------|----------|-------|-----------|
| Observability dashboard | ✅ | ✅ | ✅ | ✅ |
| **Pre-execution blocking** | ❌ | ❌ | ❌ | ✅ |
| **Human-in-the-loop approvals** | ❌ | ❌ | ❌ | ✅ |
| **Zero-config tool classification** | ❌ | ❌ | ❌ | ✅ |
| **Cryptographic audit trail** | ❌ | ❌ | ❌ | ✅ |
| **Kill switch** | ❌ | ❌ | ❌ | ✅ |
| **Natural language policy editor** | ❌ | ❌ | ❌ | ✅ |
| **Behavioral anomaly detection** | ❌ | ❌ | ❌ | ✅ |
| **HTTP proxy for closed-source agents** | ❌ | ❌ | ❌ | ✅ |
| **MCP server for Claude Desktop** | ❌ | ❌ | ❌ | ✅ |
| **LLM-as-a-Judge evaluation** | ❌ | ❌ | ❌ | ✅ |
| **Multi-tenancy & RBAC** | ❌ | ❌ | ❌ | ✅ |
| **Admin audit log (SOC 2)** | ❌ | ❌ | ❌ | ✅ |
| **Usage metering & quotas** | ❌ | ❌ | ❌ | ✅ |
| **SLA metrics (P50/P95/P99)** | ❌ | ❌ | ❌ | ✅ |
| **Data retention policies (GDPR)** | ❌ | ❌ | ❌ | ✅ |
| **Supply chain security** | ❌ | ❌ | ❌ | ✅ |
| **Slack / PagerDuty alerts** | ❌ | ❌ | ❌ | ✅ |
| Self-hostable, MIT-licensed | ✅ | ❌ | ❌ | ✅ |

---

## How it works

```
  Your agent calls a tool
          │
          ▼  SDK / HTTP Proxy / MCP Proxy intercepts
  ┌────────────────────────────────────────────────┐
  │  AEGIS Gateway                                 │
  │                                                │
  │  ① Classify   (SQL? file? network? shell?)     │
  │  ② Anomaly    (baseline deviation? spike?)     │
  │  ③ Evaluate   (injection? exfil? traversal?)   │
  │  ④ Decide     allow / block / pending          │
  └──────────┬─────────────────────────────────────┘
             │
      ┌──────┴──────────────┐
      │                     │
   allow                 pending ──► Human reviews in Cockpit
      │                     │               │
      ▼                     └──── allow ────┘
  Tool executes                        │
      │                             block
      ▼                                │
  Optional signing                    ▼
  SHA-256 hash-chained       AgentGuardBlockedError
  Stored in Cockpit          (agent gets the reason)
```

**Zero-config classification** — works on any tool name, any argument shape:

| Your tool call | AEGIS detects | How |
|----------------|---------------|-----|
| `run_query(sql="SELECT...")` | `database` | SQL keyword in args |
| `my_tool(path="/etc/passwd")` | `file` | Sensitive path pattern |
| `do_thing(url="http://...")` | `network` | URL in args |
| `helper(cmd="rm -rf /")` | `shell` | Command injection signal |
| `custom_fn(prompt="ignore previous...")` | `prompt-injection` | Known attack pattern |
| `exec(cmd="npm publish")` | `supply-chain` | Publish/deploy command |

---

## Key Features

### Pre-Execution Blocking

AEGIS doesn't just log — it **stops dangerous tool calls before they execute**.

```python
agentguard.auto(
    "http://localhost:8080",
    blocking_mode=True,             # pause HIGH/CRITICAL calls for human review
    human_approval_timeout_s=300,   # auto-block after 5 min with no decision
)
```

<table>
<tr>
<td width="50%">

**SQL injection — blocked instantly**

<img src="docs/images/block.png" alt="Blocked SQL injection" width="100%">

</td>
<td width="50%">

**High-risk action — awaiting human approval**

<img src="docs/images/pending.png" alt="Pending approval" width="100%">

</td>
</tr>
</table>

The agent pauses. You open the Cockpit, inspect the exact arguments, and click **Allow** or **Block**. The agent resumes in under a second.

```python
from agentguard import AgentGuardBlockedError

try:
    response = client.messages.create(...)
except AgentGuardBlockedError as e:
    print(f"Blocked: {e.tool_name} — {e.reason} ({e.risk_level})")
```

### Policy Engine

Seven policies ship by default. Create more in plain English — the AI assistant generates the JSON schema for you.

| Policy | Risk | What it catches |
|--------|------|-----------------|
| SQL Injection Prevention | HIGH | `DROP`, `DELETE`, `TRUNCATE` in database tools |
| File Access Control | MEDIUM | Path traversal (`../`), `/etc/`, `/root/` |
| Network Access Control | MEDIUM | HTTP (non-HTTPS) requests |
| Prompt Injection Detection | CRITICAL | "ignore previous instructions" patterns |
| Data Exfiltration Prevention | HIGH | Large payloads to external endpoints |
| Source Map Leak Prevention | HIGH | `npm publish` when `.map` files present |
| Supply Chain Security | HIGH | Package publish, container push, deployment ops |

> *"Block all file deletions outside the /tmp directory"* → Describe button → policy created instantly.

### Behavioral Anomaly Detection

AEGIS builds a behavioral profile for each agent and flags deviations in real time — no manual rules required.

**Nine-dimensional analysis:**

| Dimension | What it catches |
|-----------|-----------------|
| Tool novelty | Agent uses a tool it has never called before |
| Frequency spike | Sudden burst of calls (3x above normal rate) |
| Argument shape drift | Parameters don't match historical patterns |
| Argument length outlier | Unusually large payloads (data exfiltration signal) |
| Temporal anomaly | Calls at unusual hours |
| Sequence anomaly | Unexpected tool ordering (e.g. `delete` without prior `read`) |
| Cost spike | Single call costs 5x the agent's average |
| Risk escalation | Jump from LOW-risk to HIGH-risk tools |
| Session burst | Too many calls in one session |

**Cold-start safe** — AEGIS learns for the first 200 traces before blocking, so new agents are never false-positived.

### Proxy Interception (for closed-source agents)

For agents you can't modify (compiled binaries, third-party tools), AEGIS provides two proxy modes:

**HTTP Forward Proxy** — intercepts LLM API calls (Anthropic / OpenAI):

```bash
# Start the proxy
agentguard http-proxy --port 8081 --agent-id my-agent

# Point any agent at it — zero code changes
export ANTHROPIC_BASE_URL=http://localhost:8081
export OPENAI_BASE_URL=http://localhost:8081/v1
```

Captures: full prompt/response, tool_use calls, token usage, cost. Supports SSE streaming.

**MCP Stdio Proxy** — wraps any MCP server with policy enforcement:

```bash
agentguard mcp-proxy \
  --server npx -y @modelcontextprotocol/server-filesystem / \
  --agent-id my-agent --blocking
```

Every MCP `tools/call` is policy-checked and anomaly-scored before reaching the upstream server.

| Proxy | Intercepts | Use case |
|-------|-----------|----------|
| HTTP Proxy | LLM API calls (Anthropic/OpenAI) | Closed-source agents, binary tools |
| MCP Proxy | MCP tool calls (stdio JSON-RPC) | Claude Desktop, any MCP client |
| SDK | LLM SDK calls (monkey-patch) | Your own Python/JS/Go code |

### Compliance Cockpit

<table>
<tr>
<td width="50%">

**Forensic trace detail**

<img src="docs/images/trace.png" alt="Trace details" width="100%">

</td>
<td width="50%">

**Policy management**

<img src="docs/images/policies.png" alt="Policies" width="100%">

</td>
</tr>
<tr>
<td width="50%">

**Token cost tracking**

<img src="docs/images/cost.png" alt="Cost tracking" width="100%">

</td>
<td width="50%">

**Session grouping**

<img src="docs/images/session.png" alt="Sessions" width="100%">

</td>
</tr>
</table>

**Everything you need in one dashboard:**
- **Live Feed** — every tool call as it happens, with risk badges
- **Approvals** — one-click allow/block for pending checks
- **Agent Baseline** — 7-day behavioral profile per agent
- **Anomaly Detection** — automatic flagging of spikes, error bursts, unusual patterns
- **PII Detection** — auto-redacts SSN, email, phone, credit card, API keys
- **Cost Tracking** — token usage and USD cost across 40+ models
- **Alert Rules** — Slack, PagerDuty, or webhook on violations/cost spikes
- **Supply Chain Security** — pre-publish scanning for source maps, secrets, and dangerous files
- **LLM-as-a-Judge** — automated trace evaluation (safety, helpfulness, correctness, compliance) via OpenAI/Anthropic/Gemini
- **Forensic Export** — PDF compliance reports and CSV audit bundles
- **Kill Switch** — auto-revoke agents after N violations
- **Enterprise Admin** — multi-tenancy, RBAC, usage quotas, SLA metrics, data retention

### Enterprise (B2B)

AEGIS is built for enterprise deployment from day one.

**Multi-Tenancy & RBAC** — isolate data per organization, assign roles (owner / admin / auditor / viewer), issue scoped API keys with rate limits and expiry:

```bash
agentguard admin create-org --name "Acme Corp" --slug acme --plan enterprise
agentguard admin create-user <org-id> -e admin@acme.com -r admin
agentguard admin create-key <org-id> --name "Production" --rate-limit 5000
```

**Admin Audit Log** — every policy change, approval decision, key rotation, and kill-switch action is recorded in an immutable audit trail. Required for SOC 2, ISO 27001, HIPAA, and FedRAMP:

```bash
agentguard admin audit-log --action policy.create --limit 50
```

**Usage Metering & Quotas** — track API calls, traces, judge evaluations per org. Plan-based limits (free / pro / enterprise) with automatic enforcement:

```bash
agentguard admin usage <org-id>
```

**SLA Metrics** — real-time P50/P95/P99 latency tracking, uptime percentage, error rates:

```bash
agentguard admin sla --hours 24
```

**Data Retention** — configurable auto-purge per resource type (traces, violations, audit log). GDPR / CCPA compliant:

```bash
agentguard admin retention
```

### Supply Chain Security

AI agents can `npm publish`, `docker push`, or `kubectl apply` — publishing source maps, secrets, and internal code without human review. AEGIS intercepts these operations before they execute.

**What AEGIS catches:**

| Threat | Detection | Action |
|--------|-----------|--------|
| Source map leak (`.map` files with full source) | Pre-publish scan, classifier pattern | Block + require approval |
| Secrets in build artifacts (AWS keys, API tokens) | 11 regex patterns across build output | Block immediately |
| Dangerous files (`.env`, `.npmrc`, private keys) | File name + content scanning | Block immediately |
| Unsafe publish commands (`npm publish`, `docker push`) | Tool classifier + policy engine | Require human approval |
| `sourceMappingURL` references in production JS | Content scan | Flag as MEDIUM risk |

**CLI pre-publish scanner:**

```bash
agentguard scan ./my-package              # scan before publish
agentguard scan ./my-package --fix        # auto-add *.map to .npmignore
```

Scans for `.map` files, embedded `sourcesContent`, secrets (AWS/GitHub/npm/OpenAI/Anthropic keys, JWTs, database URLs), dangerous config files, and validates `.npmignore` / `package.json` files field.

### Cryptographic Audit Trail

Every trace is:
- **Optional Ed25519 signing** — available in the Python SDK for cryptographically verifiable traces
- **SHA-256 hash-chained** — each trace commits to the previous, tamper-evident
- **Immutable** — any modification breaks the chain, detectable by any third party

This isn't just logging. It is a **tamper-evident audit record** for reviewing how your AI agents operated within policy.

---

## SDK Support

**9 Python frameworks. JavaScript/TypeScript. Go. All auto-patched, zero code changes.**

<table>
<tr>
<td>

**Python** — `pip install agentguard-aegis`

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

</td>
<td>

**JavaScript / TypeScript** — `npm install @justinnn/agentguard`

```typescript
import agentguard from '@justinnn/agentguard'
agentguard.auto('http://localhost:8080', {
  agentId: 'my-agent',
  blockingMode: true,
})
// Existing code unchanged
```

**Go** — `go get github.com/Justin0504/Aegis/packages/sdk-go`

```go
guard := agentguard.Auto()
defer guard.Close()

result, err := guard.Wrap("query_db", args,
  func() (any, error) {
    return db.Query("SELECT ...")
  },
)
```

Zero external dependencies. Standard library only.

</td>
</tr>
</table>

---

## Integrations

### Claude Desktop (MCP)

Ask Claude about your agents directly:

```json
{
  "mcpServers": {
    "aegis": { "url": "ws://localhost:8080/mcp-audit" }
  }
}
```

> *"What did agent X do in the last hour?"* → Claude queries AEGIS and tells you.

Available tools: `query_traces`, `list_violations`, `get_agent_stats`, `list_policies`

### Claude Code

One command to audit every tool call in Claude Code:

```bash
agentguard claude-code setup --blocking
# Restart Claude Code — done.
```

Every `Read`, `Write`, `Bash`, `Edit` call is now policy-checked and traced. HIGH/CRITICAL calls require human approval in the Cockpit.

### CLI

```bash
agentguard status                    # gateway health
agentguard traces list --agent X     # query traces
agentguard costs                     # token/cost summary
agentguard anomalies list            # behavioral anomaly events
agentguard http-proxy                # start HTTP forward proxy
agentguard mcp-proxy --server ...    # start MCP stdio proxy
agentguard judge batch               # auto-evaluate unscored traces via LLM
agentguard judge stats               # judge score statistics & trends
agentguard scan [dir] [--fix]         # pre-publish supply chain scan
agentguard kill-switch revoke <id>   # emergency agent shutdown
agentguard admin orgs                # list organizations (multi-tenant)
agentguard admin create-org          # create a new tenant organization
agentguard admin users <org>         # list users and roles
agentguard admin audit-log           # view admin audit trail (SOC 2)
agentguard admin usage <org>         # usage metering & quota dashboard
agentguard admin sla                 # SLA metrics (P50/P95/P99 latency)
agentguard admin retention           # data retention policies (GDPR)
```

### OpenTelemetry

Forward every trace to Datadog, Grafana, Jaeger, or any OTLP-compatible collector:

```bash
OTEL_ENABLED=true OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node dist/server.js
```

Each span carries: `aegis.agent_id`, `aegis.risk_level`, `aegis.blocked`, `aegis.cost_usd`, `aegis.pii_detected`

### Alerting

Threshold-based alerts delivered to **Slack**, **PagerDuty**, or custom **webhooks** when violations, cost spikes, or anomalies are detected.

---

## Fine-Tuning

Not everything needs to be blocked. Precision controls for production:

```python
agentguard.auto(
    "http://localhost:8080",
    block_threshold="HIGH",          # only block HIGH and CRITICAL (default)
    allow_tools=["read_file"],       # whitelist specific tools
    allow_categories=["network"],    # whitelist entire categories
    audit_only=True,                 # log everything, block nothing
    tool_categories={                # override auto-classification
        "my_query_runner": "database",
        "send_email": "communication",
    },
)
```

---

## Architecture

```
packages/
  gateway-mcp/          Express + SQLite gateway (policy engine, anomaly detector, classifier, PII, cost, OTEL)
  sdk-python/           Python SDK — 9 frameworks auto-patched
  sdk-js/               TypeScript SDK — Anthropic, OpenAI, LangChain, Vercel AI
  sdk-go/               Go SDK — zero dependencies, stdlib only
  core-schema/          Shared Zod schemas (trace format, risk levels, approval status)
  cli/                  CLI tool + HTTP/MCP proxies for closed-source agent interception

apps/
  compliance-cockpit/   Next.js dashboard (10 tabs, live feed, approvals, admin panel, forensic export)

demo/
  live-agent/           Real Claude-powered demo agent with chat UI (FastAPI)
  showcase_agent.py     Multi-step feature demonstration script
```

**Tech Stack**: Node.js 20, Express, SQLite, Next.js 14, React 18, TailwindCSS, Python 3.10+, Go 1.21+

---

## Deployment

### Docker Compose (recommended)

```bash
docker compose up -d                              # production
docker compose -f docker-compose.dev.yml up       # development (hot-reload)
```

### Manual

```bash
# Gateway
cd packages/gateway-mcp && npm install && npm run build && node dist/server.js

# Cockpit
cd apps/compliance-cockpit && npm install && npm run build && npm start

# Agent
pip install agentguard-aegis
```

### Cloud

Pre-configured for **Render** (`render.yaml`), **Railway** (`railway.json`), and **Kubernetes** (`kubernetes/`).

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_PORT` | `8080` | Gateway listen port |
| `DB_PATH` | `./agentguard.db` | SQLite database path |
| `OTEL_ENABLED` | `false` | Enable OpenTelemetry export |
| `NEXT_PUBLIC_GATEWAY_URL` | `http://localhost:8080` | Cockpit → Gateway URL |

---

## Try the Demo Agent

A real Claude-powered research assistant with its own chat UI, fully integrated with AEGIS:

```bash
# Prerequisites: gateway on :8080, cockpit on :3000
cd demo/live-agent
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
python app.py
```

Open [localhost:8501](http://localhost:8501) and follow the guided prompts:

1. **Search for AI trends** → traces appear in Live Feed, cost tracked
2. **Read Q1 revenue data** → file access tracing, session grouping
3. **Query top customers** → safe SQL execution (ALLOW)
4. **SQL injection attempt** → blocked instantly (BLOCK)
5. **Analyze text with SSN** → PII auto-detected and flagged
6. **Send a report** → blocking mode, requires human approval in Cockpit

---

## Paper

If you use AEGIS in your research, please cite our paper:

> **AEGIS: No Tool Call Left Unchecked -- A Pre-Execution Firewall and Audit Layer for AI Agents**
> Aojie Yuan, Zhiyuan Su, Yue Zhao
> *arXiv:2603.12621*, 2026
> [[PDF]](https://arxiv.org/abs/2603.12621)

```bibtex
@article{yuan2026aegis,
  title={AEGIS: No Tool Call Left Unchecked -- A Pre-Execution Firewall and Audit Layer for AI Agents},
  author={Yuan, Aojie and Su, Zhiyuan and Zhao, Yue},
  journal={arXiv preprint arXiv:2603.12621},
  year={2026}
}
```

---

## Contributing

Issues and PRs welcome. Development setup:

```bash
git clone https://github.com/Justin0504/Aegis && cd Aegis
docker compose -f docker-compose.dev.yml up    # hot-reload enabled
```

---

<div align="center">

**MIT Licensed** · Self-hostable · Infrastructure-first · Designed to keep sensitive agent workflows under your control

Built by [Justin](https://github.com/Justin0504)

</div>
