# AEGIS · Operations

Runbook for the person on-call. Assumes the gateway is deployed and
you know your way around a terminal. For "install from scratch" go
to [`GETTING_STARTED.md`](../GETTING_STARTED.md).

## Health checks

| Endpoint | What it says | Auth |
|---|---|---|
| `GET /health` | Gateway is up + version + uptime_s | none |
| `GET /metrics` | Prometheus RED metrics (see below) | none |
| `GET /api/v1/rollback/metrics` | Rollback subsystem Prometheus data | org key |

CLI equivalents:

```bash
agentguard status                # /health
agentguard --json status         # machine-readable
agentguard doctor                # end-to-end connectivity + config check
```

## Observability

**Prometheus scrape config** — copy from [`tools/grafana/README.md`](../tools/grafana/README.md).
Two jobs: `/metrics` (open) and `/api/v1/rollback/metrics` (org key).

**Grafana dashboards**:

- `tools/grafana/aegis-overview.json` — RED. Import first.
- `tools/grafana/aegis-rollback.json` — Rollback subsystem.

**Key SLIs** already exposed:

- `sum(rate(aegis_http_requests_total[5m]))` — throughput
- `sum(rate(aegis_http_requests_total{status=~"5.."}[5m])) / sum(rate(aegis_http_requests_total[5m]))` — error rate
- `histogram_quantile(0.99, sum(rate(aegis_http_request_duration_ms_bucket[5m])) by (le))` — p99 latency
- `sum(rate(aegis_rollback_total{outcome="failed"}[5m])) / sum(rate(aegis_rollback_total[5m]))` — rollback failure rate

## Live tail

```bash
agentguard tail                          # every trace, colour-coded by risk
agentguard tail --risk HIGH              # only HIGH+
agentguard tail --agent <id> --tool stripe   # focused
agentguard --json tail | jq              # pipe into anything
```

Polls `/api/v1/traces?since=...` every 2 s. Bounded seen-set dedupes
across the poll boundary.

## Backup + restore

**SQLite hot-copy** (safe under WAL):

```bash
sqlite3 /var/lib/aegis/gateway.db ".backup /backups/aegis-$(date +%F).db"
```

Restore = stop the gateway, `cp backups/aegis-YYYY-MM-DD.db
/var/lib/aegis/gateway.db`, start the gateway. Legacy schemas
auto-migrate on next boot.

**Transparency log**: the transparency log's signed tree head is
appended to `transparency_log` in the same DB. A backup of the DB
IS a backup of the tree — no separate step. The witness cosignature
protocol lets external verifiers vouch for tree heads without your
help; publish the current tree head at
`GET /api/v1/transparency-log/sth`.

## Rollback runbook

When a rollback lands in the DLQ (compensator failed after retries):

1. **List pending entries** — `agentguard --json rollback dlq list`
   or Cockpit → Rollbacks → Dead-letter queue.
2. **Inspect the last error** — `agentguard rollback dlq inspect <id>`.
   The most common failure modes are (a) webhook target is down,
   (b) compensator template rendered against wrong trace, (c) the
   op was already rolled back out-of-band.
3. **Retry** — `agentguard rollback dlq retry <id>`. The retry runs
   with a fresh idempotency key so a partial success won't
   double-compensate.
4. **Dismiss** if the state is already good — `agentguard rollback dlq
   dismiss <id> --note "already reconciled by ops"`. This records the
   actor + note on the audit row so a future auditor can trace the
   decision.

## Manual replay of SDK-persisted traces

If an SDK reported disk-persisted traces after a gateway outage, the
SDK auto-replays on next process start. If the process is long-lived
(a daemon that never restarts) you can manually drain:

```bash
agentguard replay                          # ~/.agentguard/traces
agentguard replay --dir /var/aegis/traces  # custom path
agentguard replay --dry-run                # list without sending
agentguard --json replay --dry-run | jq .queued
```

Stops on first failure so an operator can investigate before firing
the whole queue at a broken gateway.

## Rate limits + quotas

Two knobs, set via env at gateway start:

```
RATE_LIMIT_MAX=100                  # requests / window / key
RATE_LIMIT_WINDOW_MS=60000          # window size
SKIP_BILLING=1                      # dev only — bypass plan quota
```

The abuse limiter is per `(orgId, agent_id)` key. The billing gate
(applied on POST /check) is per plan (`free` → 1k checks/month;
`pro`, `team`, `enterprise` scaled up). Set `SKIP_BILLING=1` for
self-host / dev where Stripe isn't wired.

## Multi-tenant deployment notes

- Every mutable resource is scoped by `org_id`. The tenant-isolation
  harness (`npm run test:isolation`) verifies this on every push —
  add scenarios there when you add a new endpoint.
- The `traces` table's `org_id` column is nullable to keep legacy
  self-host rows queryable via the `COALESCE(org_id, 'default')`
  fallback (Round D).
- The `default` org is reserved for solo / self-host use. In SaaS
  mode, mint per-tenant `aegis_...` keys via
  `POST /api/v1/admin/keys` and never let a tenant see the `default`
  bucket.

## Performance envelope

See [`PERFORMANCE.md`](../PERFORMANCE.md) for full numbers.
Headline on a MacBook, single instance:

- `/health`: 15,700 rps, p99 12 ms
- `POST /traces` (unique rows): 340 rps, p95 52 ms
- `POST /traces/search` (indexed field): 553 rps, p95 92 ms
- `POST /traces/search` (dynamic JSON path): 100 rps, p95 720 ms
  — flagged as the tuning target; needs a schema-aware index per
  customer.

## What breaks + how to spot it

| Symptom | Where to look | What to do |
|---|---|---|
| Gateway starts, then crashes with `no such column: ...` | `packages/gateway-mcp/src/db/database.ts` migrations | Rebuild + restart. Migrations are idempotent, so a stale `dist/` was the culprit. |
| Cockpit shows "Gateway unreachable" | `apps/compliance-cockpit/src/app/api/gateway/[...path]/route.ts` | Verify `GATEWAY_URL` env; check the proxy route hasn't double-prefixed `/api/v1/`. |
| Every request returns 401 to a route that used to work | `packages/gateway-mcp/src/middleware/auth.ts` | Check `isOpenRoute` — Round E fixed a bug where mount-scoped `requireAuth` saw a stripped `req.path` and stopped honouring the SDK ingest allowlist. |
| Rollback silently fires twice for the same trace | `packages/gateway-mcp/src/services/rollback.ts` `rollback_locks` claim | Should be impossible after Round B, but if it happens, check the lock table isn't being cleared by an out-of-band migration. |
| `POST /traces/search` returns 0 rows for a query that used to work | Was the `org_id` on the ingested rows populated? Check with `sqlite3 gateway.db "SELECT org_id, COUNT(*) FROM traces GROUP BY 1"` | Rows written before Round D have `org_id = NULL` and only match if the caller resolves to `'default'`. Migrate: `UPDATE traces SET org_id='<real>' WHERE org_id IS NULL`. |
