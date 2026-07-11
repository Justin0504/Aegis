# AEGIS · Testing

Four harnesses, layered from cheap-and-fast to slow-and-thorough.
Every push should run all four green.

| Harness | Command | Wall-clock | Catches |
|---|---|---:|---|
| Jest unit / integration | `npm test` | ~8 s | Service + API logic in isolation. |
| E2E smoke | `npm run test:e2e` | ~7 s | Every endpoint responds correctly against a real gateway boot. |
| Tenant isolation | `npm run test:isolation` | ~5 s | Cross-tenant leaks — org A can't see org B's data. |
| SDK reliability chaos | `npm run test:sdk-chaos` | ~15 s | SDK survives gateway blip + restart, replays disk queue, doesn't panic on 4xx. |

Add `:nobuild` to any of the last three (`test:e2e:nobuild`,
`test:isolation:nobuild`, `test:sdk-chaos:nobuild`) to reuse the
existing gateway `dist/` — useful in a fast local edit-loop.

## Jest — `npm test`

Located under `packages/gateway-mcp/src/__tests__/`. 97 suites at
last count. Table-stakes: service logic in isolation with in-memory
SQLite, no HTTP, no gateway boot. Fast enough to run on save.

Notable suites:

- `trace-query-dsl.test.ts` — parser + compiler + injection resistance
- `rollback-chaos.test.ts` — concurrent rollback race, DLQ, causal cycle
- `saga.test.ts` — state machine transitions
- `trace-search.test.ts` — integration test hitting FTS + generated columns

## E2E smoke — `npm run test:e2e`

Source: [`tools/e2e/smoke.mjs`](../tools/e2e/smoke.mjs). Boots the
gateway on a temp DB, seeds a dashboard key via `node:sqlite`, runs
12 golden path scenarios sequentially:

- `gateway_health` · startup crash catcher
- `metrics_prometheus` · scrape format regression
- `trace_ingest_and_list` · insert + FTS trigger + list
- `trace_search_dsl` · DSL compiler + `$.arguments.label` regression
- `delegation_endpoint` · GET /:id/delegation for the cockpit waterfall
- `saved_queries_crud` · lifecycle + DSL validation on save
- `check_endpoint_reachable` · policy engine responds structurally
- `auth_bootstrap` · dashboard API key auto-issue
- `rollback_saga_lifecycle` · sagas / metrics / DLQ list endpoints
- `kill_switch_reachable` · emergency stop route
- `policies_reachable` · policies endpoint on empty set
- `cross_tenant_isolation` · saved-queries CRUD with x-test-org header

Each scenario documents `prevents:` — the class of bug it catches.
Failed scenarios print the assertion + the docstring so the fix
context is one line away.

## Tenant isolation — `npm run test:isolation`

Source: [`tools/e2e/tenant-isolation.mjs`](../tools/e2e/tenant-isolation.mjs).
Seeds TWO org-scoped `aegis_...` keys (org-A, org-B) into a fresh
gateway, then runs 6 scenarios that verify org B cannot see, modify,
or delete org A's resources:

- `saved_queries_isolation`
- `policies_shape_consistency`
- `agents_isolation`
- `rollback_sagas_isolation`
- `dlq_isolation`
- `traces_search_isolation`

Round D turned this harness up and found four real bugs in one sitting
(traces table had no `org_id` column, saved-queries wasn't behind
auth, `datetime("now")` with double quotes 500'd every request, and
the trace-search fixture had drifted). All fixed. This harness now
gates every merge.

## SDK reliability chaos — `npm run test:sdk-chaos`

Source: [`tools/e2e/sdk_chaos.py`](../tools/e2e/sdk_chaos.py). Boots
a gateway, uses the real Python SDK to send traces through it, kills
the gateway, sends more, restarts, spins up a fresh SDK instance,
verifies startup replay drained the disk queue. 5 scenarios:

- `happy_path` — 5 traces sent, all delivered
- `gateway_kill_persist` — outage → retries exhaust → circuit trips → traces on disk
- `restart_replay` — new SDK instance drains the disk queue via startup replay
- `malformed_payload_does_not_trip` — 4xx doesn't persist to disk, doesn't trip the breaker
- `metrics_snapshot_shape` — every documented counter is present

## Load test — `npm run loadtest`

Source: [`tools/loadtest/`](../tools/loadtest/). Not run on every push
(it's a real load test with per-scenario duration). Writes
[`PERFORMANCE.md`](../PERFORMANCE.md) with the latest numbers.

## Running the full matrix locally

```bash
npm test                            # ~8 s
npm run test:e2e                    # ~7 s
npm run test:isolation              # ~5 s
npm run test:sdk-chaos              # ~15 s
```

Total: ~35 s for a full-matrix green. If one harness fails, the
others still run — parallel-safe (each boots on a different port).

## Wiring into CI

Sample GitHub Actions job:

```yaml
- run: npm ci
- run: npm test
- run: npm run test:e2e
- run: npm run test:isolation
- run: npm run test:sdk-chaos
```

The last three use `--no-build` flavours if you build once earlier
in the job:

```yaml
- run: npm run build
- run: npm test
- run: npm run test:e2e:nobuild
- run: npm run test:isolation:nobuild
- run: npm run test:sdk-chaos:nobuild
```

## Writing a new scenario

Each harness is a single `.mjs` / `.py` file with a `SCENARIOS`
array. Copy the shape of any existing entry:

```javascript
{
  name: 'my_scenario',
  prevents: 'What class of bug does this catch — one sentence.',
  run: async () => {
    // hit the gateway via `http()`, assert on responses
    const r = await http('GET', '/api/v1/something');
    assertEq(r.status, 200, 'something status');
  }
}
```

The `prevents:` docstring is required — if the test fires on a
future regression, the docstring tells the maintainer WHY it exists
without them having to `git blame`.
