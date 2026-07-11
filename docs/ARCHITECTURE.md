# AEGIS · Architecture

A single-page view of what's actually in the repo, how the components
connect at runtime, and where each responsibility lives. If you land
on the repo cold, read this before the code.

## The one-paragraph version

An AI agent's SDK wraps every tool call in a check-then-emit pair. The
**gateway** is the policy + audit hot path: SDK → `POST /check` →
allow / block / require-human → SDK → tool → SDK → `POST /traces`.
Everything the gateway sees lands in a SQLite audit log with a
Merkle transparency-log receipt. A **cockpit** UI queries the gateway
for operator workflows (traces, policies, approvals, rollbacks). A
**CLI** wraps the same gateway API for scripts + CI. Everything is
open-source under MIT.

## Component map

```
                    ┌────────────────────────────┐
                    │   Agent framework +        │
                    │   AEGIS SDK (py / js)      │
                    │   ────────────────────     │
                    │   guard.check(tool_call)   │
                    │   guard.emit(trace)        │
                    └───────────────┬────────────┘
                                    │  HTTPS
                                    │
                                    ▼
   ┌─────────────────────────────────────────────────────────────┐
   │                     Gateway (Node / Express)                 │
   │  ─────────────────────────────────────────────────────────  │
   │  Policy engine  ·  Anomaly detector  ·  LLM judge            │
   │  Rollback saga  ·  Delegation tracer ·  Cost meter           │
   │  DSL search     ·  FTS5 index        ·  Transparency log     │
   │  Prometheus /metrics  ·  RFC 6962 audit trail                │
   └──────────────┬───────────────────────────┬──────────────────┘
                  │                           │
                  │ HTTPS                     │ scrape
                  ▼                           ▼
   ┌────────────────────────┐    ┌─────────────────────────────┐
   │  Cockpit (Next.js)     │    │  Prometheus + Grafana       │
   │  ────────────────────  │    │  ─────────────────────────  │
   │  Traces, policies,     │    │  RED overview + rollback    │
   │  approvals, rollback   │    │  dashboards (tools/grafana) │
   │  UI, delegation viz    │    │                             │
   └────────────────────────┘    └─────────────────────────────┘
```

## Packages

| Path | What it is | Language |
|---|---|---|
| [`packages/gateway-mcp/`](../packages/gateway-mcp) | The gateway. Express + SQLite. Serves `/api/v1/*` + `/metrics`. | TypeScript |
| [`packages/core-schema/`](../packages/core-schema) | Zod / Pydantic schemas shared by SDK + gateway. Wire format lives here. | TS + Python |
| [`packages/sdk-python/`](../packages/sdk-python) | Python SDK. Auto-instruments 9 frameworks; owns the reliability layer (retry + circuit breaker + disk queue). | Python |
| [`packages/sdk-js/`](../packages/sdk-js) | Same story for JavaScript / TypeScript. | TypeScript |
| [`packages/sdk-go/`](../packages/sdk-go) | Go SDK (experimental). | Go |
| [`packages/cli/`](../packages/cli) | `agentguard` command — 48 subcommands, global `--json`, tab completion, `tail`, `replay`. | TypeScript |
| [`apps/compliance-cockpit/`](../apps/compliance-cockpit) | Next.js dashboard. Reads from the gateway. | TypeScript |
| [`apps/marketing/`](../apps/marketing) | Astro marketing site at aegistraces.com. | Astro |

## Data flow: one tool call, cradle to receipt

1. **Agent** wants to call `stripe.charge({amount: 5000})`.
2. **SDK** intercepts. It emits `POST /api/v1/check` with the call
   metadata and blocks the agent until the response arrives.
3. **Gateway** runs the check through three layers in order:
   - **Policy DSL** (deterministic rules)
   - **Anomaly detector** (Mahalanobis distance over the agent's
     historical behaviour, Round 2 · `services/anomaly-detector.ts`)
   - **LLM judge** for high-risk categories, calibrated Expected
     Calibration Error (see `services/llm-judge.ts` + the CALIBRATION
     reports in `docs/`).
4. Response: `allow` · `block` · `pending` (human approval required).
5. **SDK** unblocks the agent if allowed; the agent executes the tool.
6. **SDK** posts the outcome via `POST /api/v1/traces`. Gateway
   validates, denormalises (`tool_name_v`, `risk_level_v` generated
   columns for indexed search), and:
   - Persists to `traces` (SQLite, WAL mode)
   - Emits an OpenTelemetry span
   - Appends to the transparency log (RFC 6962 Merkle tree)
7. **Cockpit** polls `GET /traces` and `POST /traces/search` for
   operator views. The trace-detail waterfall reads the delegation
   scope via `GET /traces/:id/delegation`.

## Reversibility model (rollback subsystem)

Every tool declares its reversibility class:

- **idempotent** — a second invocation is a no-op (writes with the
  same key, GET-shaped side-effects). Rollback is a no-op.
- **compensable** — an inverse exists (Stripe refund for a charge,
  PostgreSQL DELETE for the row inserted). Rollback fires the
  compensator webhook.
- **irreversible** — the world moved (email sent, physical shipment).
  Rollback emits a correction-only receipt, no undo.

The gateway supports single (`POST /rollback/:trace_id`), chain
(`POST /rollback/chain`), and delegation-scoped
(`POST /rollback/delegation/:id`) rollbacks. Sagas are recorded with
a state machine (STARTED → EXECUTING → { COMPLETED | FAILED |
ABORTED | PAUSED_FOR_APPROVAL }) so concurrent operators can't
double-approve or split-brain. See `services/rollback.ts` for the
TOCTOU claim primitive (Round B).

## Test harnesses

Four layered:

| Harness | Purpose | Run |
|---|---|---|
| Jest unit / integration | Services + APIs in isolation | `npm test` — 97 suites / 1241 tests |
| E2E smoke | Real gateway boot, HTTP surface | `npm run test:e2e` — 12 golden paths |
| Tenant isolation | Two orgs, cross-tenant leak check | `npm run test:isolation` — 6 scenarios |
| SDK chaos | Real gateway + SDK kill / replay | `npm run test:sdk-chaos` — 5 scenarios |

Each harness prints a per-scenario pass/fail table with a `prevents:`
docstring so a future maintainer sees exactly which class of bug
each check exists to catch. See [`TESTING.md`](./TESTING.md).

## Where things live (quick lookup)

- **Add a new policy detector** →
  `packages/gateway-mcp/src/services/anomaly-detector.ts` +
  `packages/gateway-mcp/src/services/classifier.ts`
- **Support a new agent framework** →
  `packages/sdk-python/agentguard/interceptors/auto.py` (see how
  LangChain / CrewAI / AutoGen are wired)
- **Add a compensator** →
  `packages/gateway-mcp/src/services/compensation-registry.ts`
- **Add a DSL search field** → `services/trace-query-dsl.ts` (whitelist
  registry) + `db/database.ts` (index if performance-critical)
- **Add a cockpit tab** → `apps/compliance-cockpit/src/app/*/page.tsx`
- **Grafana dashboard** → [`tools/grafana/`](../tools/grafana/README.md)

## Prior art we implement

- **RFC 6962** — Certificate Transparency Merkle log (`services/transparency-log.ts`)
- **Toledo et al. arXiv:2606.09692** — delegation-scoped observability
  (delegation_id at ingest time; delegation-rollback endpoint)
- **Toledo et al. arXiv:2606.07119** — Three-Ring architecture
  (Ring-3 = LLM-originated actions auto-pause for approval)
- **Garcia-Molina + Salem 1987** — Saga state machines
- **Nygard "Release It!"** — Circuit breaker in the SDK reliability
  layer
