# AEGIS Gateway — Performance

> Generated: 2026-07-07T10:18:31.695Z
> Machine: darwin arm64
> Node: v22.21.1
> Per-scenario duration: 10s (warmup 2s)

Client is `tools/loadtest/load.mjs` — Node built-in fetch, fixed VU pool, all VUs sending back-to-back for the full duration. Latencies measured client-side (wall-clock around fetch); server-side p95 pulled from the gateway's Prometheus histogram delta over the run.

The numbers below are what a single-instance gateway on a MacBook can sustain today. Horizontally-scaled deployments (Docker + load balancer) will be linear in instance count for read paths, sublinear for writes (SQLite contention).

## Summary

| Scenario | VUs | Throughput (rps) | p50 | p95 | p99 | Errors |
|---|---:|---:|---:|---:|---:|---:|
| Baseline · GET /health | 10 | 15159 | 0.47ms | 1.39ms | 1.91ms | 0.00% |
| Baseline · GET /health | 50 | 15879 | 2.93ms | 4.84ms | 6.21ms | 0.00% |
| Baseline · GET /health | 100 | 15736 | 6.07ms | 9.51ms | 11.59ms | 0.00% |
| Write · POST /api/v1/traces (unique rows) | 10 | 1163 | 7.44ms | 18.06ms | 22.45ms | 0.00% |
| Write · POST /api/v1/traces (unique rows) | 50 | 613 | 78.69ms | 96.20ms | 178.13ms | 0.00% |
| Read · POST /api/v1/traces/search | 10 | 111 | 73.09ms | 155.59ms | 164.59ms | 0.00% |
| Read · POST /api/v1/traces/search | 50 | 109 | 304.68ms | 689.93ms | 6659.04ms | 0.00% |

## Notes per scenario

### Baseline · GET /health

- **Endpoint:** `GET http://localhost:8080/health`

### Write · POST /api/v1/traces (unique rows)

- **Endpoint:** `POST http://localhost:8080/api/v1/traces`

### Read · POST /api/v1/traces/search

- **Endpoint:** `POST http://localhost:8080/api/v1/traces/search`

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
    "started_at": "2026-07-07T10:17:08.738Z",
    "total_requests": 151612,
    "overflow_samples_dropped": 0,
    "ok": 151612,
    "err": 0,
    "error_status": {},
    "throughput_rps": 15159.2,
    "error_rate": 0,
    "latency_ms": {
      "p50": 0.47,
      "p90": 1.07,
      "p95": 1.39,
      "p99": 1.91,
      "p999": 2.65,
      "max": 4.21,
      "mean": 0.66
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
    "started_at": "2026-07-07T10:17:20.780Z",
    "total_requests": 158850,
    "overflow_samples_dropped": 0,
    "ok": 158850,
    "err": 0,
    "error_status": {},
    "throughput_rps": 15879.4,
    "error_rate": 0,
    "latency_ms": {
      "p50": 2.93,
      "p90": 4.22,
      "p95": 4.84,
      "p99": 6.21,
      "p999": 7.72,
      "max": 56.82,
      "mean": 3.15
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
    "started_at": "2026-07-07T10:17:32.823Z",
    "total_requests": 157471,
    "overflow_samples_dropped": 0,
    "ok": 157471,
    "err": 0,
    "error_status": {},
    "throughput_rps": 15736.1,
    "error_rate": 0,
    "latency_ms": {
      "p50": 6.07,
      "p90": 8.1,
      "p95": 9.51,
      "p99": 11.59,
      "p999": 13.45,
      "max": 254.48,
      "mean": 6.35
    },
    "server_p95_ms_delta": null,
    "server_p50_ms_delta": null
  },
  {
    "scenario": "ingest_trace",
    "vus": 10,
    "url": "http://localhost:8080/api/v1/traces",
    "method": "POST",
    "duration_s": 10.01,
    "started_at": "2026-07-07T10:17:44.872Z",
    "total_requests": 11643,
    "overflow_samples_dropped": 0,
    "ok": 11643,
    "err": 0,
    "error_status": {},
    "throughput_rps": 1162.6,
    "error_rate": 0,
    "latency_ms": {
      "p50": 7.44,
      "p90": 14.82,
      "p95": 18.06,
      "p99": 22.45,
      "p999": 25.85,
      "max": 30.85,
      "mean": 8.6
    },
    "server_p95_ms_delta": 5,
    "server_p50_ms_delta": 5
  },
  {
    "scenario": "ingest_trace",
    "vus": 50,
    "url": "http://localhost:8080/api/v1/traces",
    "method": "POST",
    "duration_s": 10.09,
    "started_at": "2026-07-07T10:17:56.939Z",
    "total_requests": 6189,
    "overflow_samples_dropped": 0,
    "ok": 6189,
    "err": 0,
    "error_status": {},
    "throughput_rps": 613.4,
    "error_rate": 0,
    "latency_ms": {
      "p50": 78.69,
      "p90": 91.22,
      "p95": 96.2,
      "p99": 178.13,
      "p999": 1305.38,
      "max": 1719.85,
      "mean": 81.15
    },
    "server_p95_ms_delta": 5,
    "server_p50_ms_delta": 5
  },
  {
    "scenario": "search_trace",
    "vus": 10,
    "url": "http://localhost:8080/api/v1/traces/search",
    "method": "POST",
    "duration_s": 10.09,
    "started_at": "2026-07-07T10:18:09.104Z",
    "total_requests": 1118,
    "overflow_samples_dropped": 0,
    "ok": 1118,
    "err": 0,
    "error_status": {},
    "throughput_rps": 110.8,
    "error_rate": 0,
    "latency_ms": {
      "p50": 73.09,
      "p90": 153.77,
      "p95": 155.59,
      "p99": 164.59,
      "p999": 302.25,
      "max": 391.27,
      "mean": 89.84
    },
    "server_p95_ms_delta": 10,
    "server_p50_ms_delta": 10
  },
  {
    "scenario": "search_trace",
    "vus": 50,
    "url": "http://localhost:8080/api/v1/traces/search",
    "method": "POST",
    "duration_s": 10.43,
    "started_at": "2026-07-07T10:18:21.252Z",
    "total_requests": 1132,
    "overflow_samples_dropped": 0,
    "ok": 1132,
    "err": 0,
    "error_status": {},
    "throughput_rps": 108.5,
    "error_rate": 0,
    "latency_ms": {
      "p50": 304.68,
      "p90": 401,
      "p95": 689.93,
      "p99": 6659.04,
      "p999": 10416.65,
      "max": 10431.89,
      "mean": 451.2
    },
    "server_p95_ms_delta": 25,
    "server_p50_ms_delta": 10
  }
]
```
