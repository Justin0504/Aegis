# AEGIS · Grafana dashboards

Ready-to-import JSON dashboards for the AEGIS gateway. Prometheus is
the datasource — the gateway already exposes the required metrics
via `GET /metrics` (gateway-wide RED) and `GET /api/v1/rollback/metrics`
(rollback subsystem).

## Dashboards

| File | Title | Sources | What it shows |
|---|---|---|---|
| `aegis-overview.json` | AEGIS · Gateway Overview | `/metrics` | Request rate, error rate, p50/p95/p99 latency, top routes, requests by status class. Sliced by tenant via the `$org` template variable. |
| `aegis-rollback.json` | AEGIS · Rollback Subsystem | `/api/v1/rollback/metrics` | Rollbacks/min, failure rate, compensator latency percentiles, outcome mix, top tool × outcome. |

Both dashboards target Grafana schema v39 (Grafana 10.x). They should
import cleanly into Grafana Cloud, self-hosted Grafana, and Grafana
Agent's UI. Older 8.x installs will need a manual schema bump.

## Prometheus scrape config

The overview metrics are exposed on `/metrics` without auth (Prometheus
convention). Restrict access at the ingress layer.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: aegis-gateway
    scrape_interval: 15s
    static_configs:
      - targets: ['gateway.internal:8080']
    metrics_path: /metrics

  - job_name: aegis-gateway-rollback
    scrape_interval: 30s
    static_configs:
      - targets: ['gateway.internal:8080']
    metrics_path: /api/v1/rollback/metrics
    authorization:
      # Reuses the same org-scoped key the SDK uses
      type: Bearer
      credentials_file: /etc/prometheus/aegis-key
```

The rollback endpoint sits under `/api/v1/*` and requires the standard
org-scoped API key. Point `credentials_file` at a file containing just
the `aegis_...` key value (Prometheus reads it verbatim).

## Import steps

**Grafana Cloud / self-hosted UI:**

1. Grafana → Dashboards → New → Import.
2. Upload `aegis-overview.json` (or paste the JSON).
3. Pick the Prometheus datasource when prompted.
4. Save. Repeat for `aegis-rollback.json`.

**Via API (idempotent, ideal for GitOps):**

```bash
curl -X POST \
  -H "Authorization: Bearer $GRAFANA_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --slurpfile d aegis-overview.json '{dashboard: $d[0], overwrite: true, message: "aegis overview vN"}')" \
  https://your-grafana.example.com/api/dashboards/db
```

## Notes on the queries

- **`$org` template on overview** — every panel filters by
  `org=~"$org"` so a multi-tenant deployment can switch between
  a single tenant, a subset, or `All`. Backed by
  `label_values(aegis_http_requests_total, org)`.
- **Rollback dashboard is un-tenanted** — the rollback exposition
  doesn't currently emit an `org` label. If your deployment
  patches that in, add the same template variable + filter.
- **Latency histograms use the standard `histogram_quantile` +
  `rate(...)_bucket` recipe** — safe over 5m windows and matches
  what SLO alert rules typically consume.
- **Status class breakdown uses `status=~"2.."`** — the metric emits
  the numeric HTTP status directly (200, 400, 500, …), so `2..`,
  `4..`, `5..` regex-slice into families.

## What's NOT in these dashboards (yet)

Ideas parked for a follow-up:

- **SDK metrics** — the Python and JS SDKs expose `traces_sent`,
  `traces_failed`, `retries_total`, `circuit_state`, `disk_backlog`,
  etc. via `service.metrics_snapshot()`. Wire an OTel exporter or a
  push-gateway on the SDK side and add a third dashboard.
- **Saga state distribution** — the saga table has `state` and
  `paused_reason`. A gauge exposition would give operators a
  "paused for approval" count at a glance.
- **Multi-instance grouping** — dashboards assume a single scrape
  target. Behind a load balancer with N instances, add `instance` to
  the `sum by` clauses and a template variable for `instance`.
