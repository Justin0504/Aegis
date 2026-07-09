# AEGIS Gateway — Performance

> Generated: 2026-07-09T07:24:43.392Z
> Machine: darwin arm64
> Node: v22.21.1
> Per-scenario duration: 10s (warmup 2s)

Client is `tools/loadtest/load.mjs` — Node built-in fetch, fixed VU pool, all VUs sending back-to-back for the full duration. Latencies measured client-side (wall-clock around fetch); server-side p95 pulled from the gateway's Prometheus histogram delta over the run.

The numbers below are what a single-instance gateway on a MacBook can sustain today. Horizontally-scaled deployments (Docker + load balancer) will be linear in instance count for read paths, sublinear for writes (SQLite contention).

## Summary

| Scenario | VUs | Throughput (rps) | p50 | p95 | p99 | Errors |
|---|---:|---:|---:|---:|---:|---:|
| Baseline · GET /health | 10 | 15301 | 0.47ms | 1.38ms | 1.92ms | 0.00% |
| Baseline · GET /health | 50 | 15946 | 2.95ms | 4.85ms | 6.38ms | 0.00% |
| Baseline · GET /health | 100 | 15715 | 6.07ms | 9.49ms | 11.68ms | 0.00% |
| Write · POST /api/v1/traces (unique rows) | 10 | 341 | 23.67ms | 51.92ms | 66.61ms | 0.00% |
| Write · POST /api/v1/traces (unique rows) | 50 | 318 | 148.44ms | 170.69ms | 449.51ms | 0.00% |
| Read · POST /api/v1/traces/search (indexed field) | 10 | 552 | 14.66ms | 31.01ms | 32.19ms | 0.00% |
| Read · POST /api/v1/traces/search (indexed field) | 50 | 553 | 86.68ms | 91.73ms | 178.00ms | 0.00% |
| Read · POST /api/v1/traces/search (JSON path, no index) | 10 | 101 | 79.77ms | 170.96ms | 181.92ms | 0.00% |
| Read · POST /api/v1/traces/search (JSON path, no index) | 50 | 100 | 324.73ms | 717.54ms | 7550.89ms | 0.00% |

## Notes per scenario

### Baseline · GET /health

- **Endpoint:** `GET http://localhost:8080/health`

### Write · POST /api/v1/traces (unique rows)

- **Endpoint:** `POST http://localhost:8080/api/v1/traces`

### Read · POST /api/v1/traces/search (indexed field)

- **Endpoint:** `POST http://localhost:8080/api/v1/traces/search`

### Read · POST /api/v1/traces/search (JSON path, no index)

- **Endpoint:** `POST http://localhost:8080/api/v1/traces/search`
- **Caveat:** Filters via json_extract on a dynamic path — no generated column can precompute this. If a customer needs this filter hot, tool_call.arguments has to expose the field as top-level in the SDK.

## Reproducing

```bash
# Kill any existing gateway; start with a high rate-limit ceiling
lsof -ti :8080 | xargs kill -9
cd packages/gateway-mcp && RATE_LIMIT_MAX=100000 node dist/server.js &

# Run the full suite (writes PERFORMANCE.md)
node tools/loadtest/run.mjs

# Or a single scenario
node tools/loadtest/load.mjs --url http://localhost:8080/health --method GET --vus 50 --duration 30
```

## Raw results

```json
[
  {
    "scenario": "baseline_health",
    "vus": 10,
    "url": "http://localhost:8080/health",
    "method": "GET",
    "duration_s": 10,
    "started_at": "2026-07-09T07:22:56.120Z",
    "total_requests": 153036,
    "overflow_samples_dropped": 0,
    "ok": 153036,
    "err": 0,
    "error_status": {},
    "throughput_rps": 15300.9,
    "error_rate": 0,
    "latency_ms": {
      "p50": 0.47,
      "p90": 1.08,
      "p95": 1.38,
      "p99": 1.92,
      "p999": 2.48,
      "max": 8.22,
      "mean": 0.65
    },
    "server_p95_ms_delta": null,
    "server_p50_ms_delta": null
  },
  {
    "scenario": "baseline_health",
    "vus": 50,
    "url": "http://localhost:8080/health",
    "method": "GET",
    "duration_s": 10,
    "started_at": "2026-07-09T07:23:08.162Z",
    "total_requests": 159508,
    "overflow_samples_dropped": 0,
    "ok": 159508,
    "err": 0,
    "error_status": {},
    "throughput_rps": 15946.3,
    "error_rate": 0,
    "latency_ms": {
      "p50": 2.95,
      "p90": 4.22,
      "p95": 4.85,
      "p99": 6.38,
      "p999": 8.12,
      "max": 49.46,
      "mean": 3.13
    },
    "server_p95_ms_delta": null,
    "server_p50_ms_delta": null
  },
  {
    "scenario": "baseline_health",
    "vus": 100,
    "url": "http://localhost:8080/health",
    "method": "GET",
    "duration_s": 10.01,
    "started_at": "2026-07-09T07:23:20.207Z",
    "total_requests": 157250,
    "overflow_samples_dropped": 0,
    "ok": 157250,
    "err": 0,
    "error_status": {},
    "throughput_rps": 15714.8,
    "error_rate": 0,
    "latency_ms": {
      "p50": 6.07,
      "p90": 8.23,
      "p95": 9.49,
      "p99": 11.68,
      "p999": 27.85,
      "max": 227.99,
      "mean": 6.36
    },
    "server_p95_ms_delta": null,
    "server_p50_ms_delta": null
  },
  {
    "scenario": "ingest_trace",
    "vus": 10,
    "url": "http://localhost:8080/api/v1/traces",
    "method": "POST",
    "duration_s": 10.03,
    "started_at": "2026-07-09T07:23:32.261Z",
    "total_requests": 3419,
    "overflow_samples_dropped": 0,
    "ok": 3419,
    "err": 0,
    "error_status": {},
    "throughput_rps": 341,
    "error_rate": 0,
    "latency_ms": {
      "p50": 23.67,
      "p90": 48.97,
      "p95": 51.92,
      "p99": 66.61,
      "p999": 101.34,
      "max": 118.46,
      "mean": 29.29
    },
    "server_p95_ms_delta": 5,
    "server_p50_ms_delta": 5
  },
  {
    "scenario": "ingest_trace",
    "vus": 50,
    "url": "http://localhost:8080/api/v1/traces",
    "method": "POST",
    "duration_s": 10.16,
    "started_at": "2026-07-09T07:23:44.333Z",
    "total_requests": 3234,
    "overflow_samples_dropped": 0,
    "ok": 3234,
    "err": 0,
    "error_status": {},
    "throughput_rps": 318.4,
    "error_rate": 0,
    "latency_ms": {
      "p50": 148.44,
      "p90": 161.65,
      "p95": 170.69,
      "p99": 449.51,
      "p999": 3280.67,
      "max": 3743.59,
      "mean": 155.79
    },
    "server_p95_ms_delta": 5,
    "server_p50_ms_delta": 5
  },
  {
    "scenario": "search_indexed",
    "vus": 10,
    "url": "http://localhost:8080/api/v1/traces/search",
    "method": "POST",
    "duration_s": 10.02,
    "started_at": "2026-07-09T07:23:56.528Z",
    "total_requests": 5525,
    "overflow_samples_dropped": 0,
    "ok": 5525,
    "err": 0,
    "error_status": {},
    "throughput_rps": 551.5,
    "error_rate": 0,
    "latency_ms": {
      "p50": 14.66,
      "p90": 30.64,
      "p95": 31.01,
      "p99": 32.19,
      "p999": 47.16,
      "max": 74.97,
      "mean": 18.11
    },
    "server_p95_ms_delta": 5,
    "server_p50_ms_delta": 5
  },
  {
    "scenario": "search_indexed",
    "vus": 50,
    "url": "http://localhost:8080/api/v1/traces/search",
    "method": "POST",
    "duration_s": 10.09,
    "started_at": "2026-07-09T07:24:08.584Z",
    "total_requests": 5581,
    "overflow_samples_dropped": 0,
    "ok": 5581,
    "err": 0,
    "error_status": {},
    "throughput_rps": 553,
    "error_rate": 0,
    "latency_ms": {
      "p50": 86.68,
      "p90": 89.09,
      "p95": 91.73,
      "p99": 178,
      "p999": 1725.59,
      "max": 2196.78,
      "mean": 90.01
    },
    "server_p95_ms_delta": 5,
    "server_p50_ms_delta": 5
  },
  {
    "scenario": "search_json_path",
    "vus": 10,
    "url": "http://localhost:8080/api/v1/traces/search",
    "method": "POST",
    "duration_s": 10.09,
    "started_at": "2026-07-09T07:24:20.747Z",
    "total_requests": 1022,
    "overflow_samples_dropped": 0,
    "ok": 1022,
    "err": 0,
    "error_status": {},
    "throughput_rps": 101.3,
    "error_rate": 0,
    "latency_ms": {
      "p50": 79.77,
      "p90": 167.89,
      "p95": 170.96,
      "p99": 181.92,
      "p999": 333.86,
      "max": 422.79,
      "mean": 98.28
    },
    "server_p95_ms_delta": 25,
    "server_p50_ms_delta": 10
  },
  {
    "scenario": "search_json_path",
    "vus": 50,
    "url": "http://localhost:8080/api/v1/traces/search",
    "method": "POST",
    "duration_s": 10.49,
    "started_at": "2026-07-09T07:24:32.899Z",
    "total_requests": 1053,
    "overflow_samples_dropped": 0,
    "ok": 1053,
    "err": 0,
    "error_status": {},
    "throughput_rps": 100.4,
    "error_rate": 0,
    "latency_ms": {
      "p50": 324.73,
      "p90": 431.87,
      "p95": 717.54,
      "p99": 7550.89,
      "p999": 10474.57,
      "max": 10484.78,
      "mean": 486.36
    },
    "server_p95_ms_delta": 25,
    "server_p50_ms_delta": 10
  }
]
```
