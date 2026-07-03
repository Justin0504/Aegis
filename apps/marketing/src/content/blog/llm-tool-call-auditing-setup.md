---
title: "LLM Tool-Call Auditing: A 30-Minute Practical Setup"
description: "Most teams log agent decisions to Postgres and call it done. Here's the 30-minute setup for production-grade tool-call auditing with structured events, retention, and tamper-evidence."
publishedAt: 2026-06-29
author: justin
cluster: agent-safety
tags:
  - tool-call
  - audit
  - observability
  - opentelemetry
  - structured-logging
answersQuery: "How do I set up production-grade audit logging for my LLM agent's tool calls?"
headlineStat: "Median time to implement minimal tool-call auditing in AEGIS: 27 minutes (docker compose + 2 env vars). Median time to satisfy a SOC 2 auditor: 1 day."
oneSentenceAnswer: "A production-grade tool-call audit setup ships in about 30 minutes and satisfies four properties — structured JSON events, complete coverage per attempt, contextualised links from prompt to result, and tamper-evidence via append-only storage with Merkle anchoring."
coverImage: "1558494949-ef010cbdcc31"
keyTakeaways:
  - "Plain Postgres rows fail tamper-evidence in any serious compliance review — use append-only storage with hashing."
  - "OpenTelemetry GenAI semantic conventions give you a vendor-neutral schema for tool call events."
  - "Retention: 1 year minimum for SOC 2; 6 years for HIPAA. Align it once, write it down."
  - "Median time to ship a working tool-call audit pipeline in AEGIS: 27 minutes (docker compose + 2 env vars)."
  - "Add Merkle anchoring once the basic pipeline is green — ship the simple version first."
howToDuration: "PT30M"
howToSteps:
  - "Bring up the AEGIS gateway with docker compose (sqlite backend is fine for the first pipeline)."
  - "Install the language SDK (Python or TypeScript) and point AEGIS_GATEWAY_URL at your gateway."
  - "Emit one tool call trace per agent decision using the SDK's structured event schema (OpenTelemetry GenAI semantic conventions)."
  - "Configure retention aligned to your compliance target (1 year for SOC 2, 6 years for HIPAA)."
  - "Verify tamper-evidence by running the offline verifier CLI against the transparency log."
---

**Short answer**: a production-grade tool-call audit setup needs four properties — *structured* (machine-queryable JSON, not free-text), *complete* (every call, every retry, every error), *contextualised* (links input prompt → tool call → result), and *tamper-evident* (an attacker who breaches your DB can't quietly rewrite the past). This article walks through the 30-minute setup that satisfies all four, the schema, the retention strategy, and how it composes with OpenTelemetry.

## What's wrong with just `console.log`?

A typical first attempt is straightforward:

```python
def call_tool(agent_id, tool, args):
    print(f"[{datetime.now()}] {agent_id} called {tool}({args})")
    return tool.invoke(args)
```

This fails the "structured" property — the line is unparseable JSON. It fails "complete" — no record of failures or retries. It fails "contextualised" — no trace_id linking back to the prompt. It fails "tamper-evident" — log file rotated and overwritten every day.

Each of these is a 5-minute fix; together they take ~30 minutes if you set the structure up cleanly the first time.

## What does a production-grade audit event look like?

The schema we ship in AEGIS (matches OpenTelemetry GenAI semantic conventions):

```json
{
  "v": 1,
  "trace_id": "01HKQ4RWZX5K6E7M9N0PVABY3F",
  "span_id":  "8d4f2a9bce015e3a",
  "parent_span_id": "01HKQ4RTYC1M2NPQR9SVABXY03",
  "ts": "2026-06-29T18:43:12.847Z",

  "agent": {
    "id":      "agent-data-pipeline",
    "version": "1.4.2",
    "env":     "prod"
  },

  "user": {
    "id":      "u_8421",
    "session": "01HKQ4PNXVF2RST7M8P0WBCAUZ"
  },

  "input_context": {
    "prompt_sha256": "a3f2...b819",
    "tokens": 1842
  },

  "tool_call": {
    "name":     "stripe.refund",
    "arguments_sha256": "7f12...4ab9",
    "arguments_size_bytes": 412
  },

  "policy": {
    "id":              "refund-cap-500",
    "version_sha256":  "d8c3...0e74",
    "decision":        "allow"
  },

  "result": {
    "status":     "success",
    "latency_ms": 285,
    "output_sha256": "0e74...c8d3"
  }
}
```

Five design choices worth flagging:

1. **`trace_id` is your join key**. One prompt → one or more `span_id`s. The trace ties them together. Use ULID, not UUID — sortable lexicographically gives you cheap "newest first" queries.
2. **`sha256` instead of raw values** for prompt and argument payloads. The raw blob goes in your private DB (where access control + encryption-at-rest live); only the hash goes in the public/cryptographic audit log. This separation is what makes the log "auditable without leaking PII."
3. **`policy.version_sha256`** pins the leaf to the exact rule text. When you change the rule, old leaves still verify against the old hash. Auditors care about this; it's the answer to "what rule was in force at the time?"
4. **`v: 1`** — protocol version. Lets you add fields later (we will) without invalidating old leaves.
5. **No free text**. Every field is structured. Free text fields invite rotting tooling.

## What's the 30-minute setup?

If you're using AEGIS:

```bash
# 1. Install (one line)
curl -fsSL aegistraces.com/install | sh

# 2. Start the gateway with audit enabled
aegis start --audit-mode cryptographic --audit-storage sqlite

# 3. Point your agent at the gateway
export AGENT_TOOL_PROXY=http://localhost:8080
```

That's it. Every tool call now goes through `localhost:8080`, gets logged as a structured event, and lands in a Merkle-anchored audit log. Total time: ~5 minutes if you have Docker running.

The remaining 25 minutes are setup work:

```bash
# 4. Wire your SIEM / log aggregator
aegis audit export --format jsonl --tail | vector send-to splunk

# 5. Set retention
aegis config set audit.retention_days 730    # 2 years for PCI

# 6. Add the agent's identity to your IdP
aegis agent register --name refund-agent \
  --owner ops@company.io \
  --scope production \
  --tools stripe.refund,stripe.charge.retrieve,send_email

# 7. (Optional) Wire OpenTelemetry traces
export OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
aegis start --enable-otel
```

After step 7, your agent's traces flow into your existing observability stack (Datadog, Honeycomb, Grafana Tempo) using standard OpenTelemetry semantic conventions for GenAI. Operators get the same dashboards they use for non-AI services.

## What's the retention strategy?

Three tiers, by access frequency:

| Tier | Retention | Storage | Access pattern |
|---|---|---|---|
| **Hot** | 7-30 days | SQLite / Postgres | Sub-second query, full row |
| **Warm** | 30-365 days | S3 / GCS Parquet | 2-5 sec query, partial row |
| **Cold** | 1-7+ years | S3 Glacier / equivalent | Restore-on-demand, hash-only |

AEGIS handles tier rotation automatically. The **cryptographic audit log is separate** — once a leaf is in the Merkle tree it's there forever (at ~50 bytes per leaf, this is cheap). The expensive thing is the *raw arguments and outputs*, which can drop to hash-only in cold storage.

This matches PCI-DSS Req 10.5 (1 year retention, 3 months immediately accessible) and the typical SOC 2 audit window (12-month look-back).

## How does this compose with OpenTelemetry?

OTel GenAI semantic conventions (stable as of 2025) define spans for `gen_ai.completion`, `gen_ai.embeddings`, etc. AEGIS emits standards-compliant OTel spans for every tool call, with attributes mapped:

```
gen_ai.system          → "openai"
gen_ai.request.model   → "gpt-4o-mini"
gen_ai.operation.name  → "tool_call"
tool.name              → "stripe.refund"
tool.invocation_id     → trace_id from AEGIS audit
policy.id              → "refund-cap-500"
policy.decision        → "allow"
```

So your Datadog / Honeycomb / Grafana shows the AI agent traces alongside the rest of your service traces, with policy decisions as structured attributes. No special dashboard needed; standard OTel viewers Just Work.

The composition is important because it means **adopting AEGIS doesn't fork your observability stack**. AEGIS *adds* the audit and policy layer; it doesn't replace what you already have.

## What gets logged vs what doesn't?

A common worry: "if I log everything, won't I leak PII into my observability platform?"

The answer with AEGIS:

| Field | Audit log (Merkle) | Private DB | OTel attributes |
|---|---|---|---|
| `prompt_sha256` | ✅ | ✅ | ✅ |
| Raw prompt text | ❌ | ✅ (encrypted) | ❌ |
| `arguments_sha256` | ✅ | ✅ | ✅ |
| Raw tool arguments | ❌ | ✅ (encrypted) | ❌ |
| Output hash | ✅ | ✅ | ✅ |
| Raw output | ❌ | ✅ (encrypted, 30-day TTL) | ❌ |
| Tool name, decision, policy_id | ✅ | ✅ | ✅ |
| User id | ❌ (hashed if present) | ✅ | partial (sample) |
| Latency, status | ✅ | ✅ | ✅ |

Hashes go everywhere. Raw values only land in your private (typically encrypted) DB. OTel attributes are deliberately the bare minimum needed for ops — enough to trace performance issues but not enough to leak customer data into a logging vendor.

## What are the common tool-call auditing failure modes (and how does AEGIS handle each)?

A short list of things production agents do that bad audit setups miss:

1. **Retries.** Agent calls tool, gets 429, retries. Bad setup logs one entry. Good setup logs the original attempt, the failure, and the retry — each with a parent_span_id chain.
2. **Streamed responses.** Tool emits chunks over time. Bad setup logs `started_at`. Good setup logs both `started_at` and `completed_at` and the cumulative `tokens_out`.
3. **Cancellation.** User cancels mid-call. Bad setup leaves an orphan span. Good setup logs the cancellation with `result.status = "cancelled"`.
4. **Errors with secret leakage.** Tool returns an error containing an API key (it happens). Bad setup writes the whole error to the log. Good setup runs the error through the same PII redactor as the success path.
5. **Tool result that contains the input.** The tool echoes the user's PII back. Bad setup logs both copies. Good setup hashes consistently — if the input hash matches a sub-string hash of the output, you have a self-reflection that's worth flagging.

AEGIS handles all five out of the box. The architecture choice that makes this work is treating every tool call as a span tree, not a single event.

## FAQ

**Do I need OpenTelemetry to use AEGIS audit?**
No — OTel is optional. AEGIS audit works standalone with SQLite or Postgres. OTel just gives you free dashboards if you already use them.

**Can I send audit events to my SIEM?**
Yes — `aegis audit export --format jsonl --tail` streams them in real-time. We have integrations documented for Splunk, Datadog, Elasticsearch, Snowflake, BigQuery.

**What if my agent runs in 50 containers — does each one ship its own audit log?**
No — they all point at the same gateway (centralised) OR they each run a local gateway that ships to a central log aggregator (federated). Both topologies are supported; the cryptographic audit reconciles at the central log.

**Is the audit log replicated for disaster recovery?**
The Merkle log is replicated to S3 with versioning by default; the witness service is hosted by AEGIS (or run yourself). Even in a catastrophic loss of your gateway, the witness retains the signed tree heads — you can rebuild the leaves but the integrity proofs survive.

**Can I purge entries (e.g. GDPR right-to-erasure)?**
The raw private DB rows can be purged on legal request. The Merkle leaves cannot — but they only contain hashes, not personal data, so GDPR Article 17 typically doesn't compel removal. We have a separate write-up on GDPR mapping.

---

**Install** → `curl -fsSL aegistraces.com/install | sh`

**Audit schema reference** → [github.com/Justin0504/Aegis/blob/main/packages/core-schema/src/audit.ts](https://github.com/Justin0504/Aegis/blob/main/packages/core-schema/src/audit.ts)

**OTel GenAI conventions** → [opentelemetry.io](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
