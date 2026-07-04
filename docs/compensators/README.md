# Compensator handler library

Copy-paste-ready reference implementations for the AEGIS rollback
webhook contract. Every handler here **matches the payload shape the
gateway sends** when it fires a `webhook` compensator (see
`packages/gateway-mcp/src/services/rollback.ts::renderPlan`):

```jsonc
POST <your compensator URL>
Idempotency-Key: <trace_id>
X-AEGIS-Attempt:   1..N
Authorization:     <if configured>
Content-Type:      application/json

{
  "trace_id":       "…",
  "agent_id":       "…",
  "tool_name":      "stripe.refund",
  "arguments":      { … original tool_call arguments … },
  "observation":    { … original observation … },
  "timestamp":      "…",
  "pre_state":      { … captured snapshot payload, if any … },
  "pre_state_hash": "sha256:…",
  "capture_kind":   "webhook" | "inline" | null
}
```

Return **HTTP 200** on success, any 4xx/5xx to trigger the gateway's
exponential-backoff retry (2 retries by default → 3 attempts total).
Failed compensations after retries land in the DLQ.

Every handler here is written to be **idempotent** — the gateway sends
a stable `Idempotency-Key: <trace_id>` header, and the recipe uses it
to dedupe against the upstream provider's idempotency store where one
exists (Stripe / Circle) or against a local `handled_ids` table where
one doesn't (Postgres / S3 / Slack).

## Handlers

- [`stripe-refund.ts`](./stripe-refund.ts) — undo a `stripe.charge` /
  `stripe.payment_intent.confirm` by issuing a refund. Uses Stripe's
  own `Idempotency-Key` header so a retry is guaranteed-safe.
- [`postgres-row.ts`](./postgres-row.ts) — undo a `postgres.insert` /
  `postgres.update` by restoring the `pre_state` snapshot in a
  single transaction.
- [`s3-delete.ts`](./s3-delete.ts) — undo an `s3.put_object` by
  deleting the object (or restoring the pre-state version if
  versioning is enabled).
- [`slack-retract.ts`](./slack-retract.ts) — undo a `slack.postMessage`
  by deleting the message (up to Slack's 6-hour edit window) and
  posting an audit line.
- [`sendgrid-retract.py`](./sendgrid-retract.py) — email can't be
  un-sent, so this handler emits a **correction email** to the same
  recipient plus a compliance mailbox, referencing the original
  message id and the reason for retraction.

Each file is standalone and MIT-licensed. Adapt the auth /
error-handling patterns to your stack.

## Wiring one up

Register the compensator per-tenant in `tenant_config.rollback`:

```yaml
rollback:
  compensators:
    stripe.refund:
      kind: webhook
      url:  https://compensators.example.com/stripe-refund
      authorization: "Bearer ${COMPENSATOR_TOKEN}"
      timeout_ms: 5000
      retries: 2
      cost_estimate:
        magnitude: high
        currency: USD
        note: "Refunds a captured Stripe charge — irreversible without cost."
    postgres.insert:
      kind: webhook
      url:  https://compensators.example.com/postgres-row
      timeout_ms: 3000
      retries: 3
      cost_estimate:
        magnitude: low
```

The `cost_estimate.magnitude` field decides whether a rollback pauses
for human approval (`high` / `catastrophic`) or fires immediately
(`low` / `medium`).

## Testing your handler

The gateway ships a `--dry-run` mode on every rollback endpoint:

```bash
curl -X POST http://localhost:8080/api/v1/rollback/<trace_id> \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: $AEGIS_API_KEY' \
  -d '{"dry_run": true}'
```

This renders the exact webhook body without firing it, so you can
copy the payload into your handler's test suite.
