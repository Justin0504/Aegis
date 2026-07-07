#!/usr/bin/env node
/**
 * Self-contained load test for the AEGIS gateway. Zero external
 * dependencies — uses Node's built-in `fetch` + a fixed-concurrency
 * worker pool. Same measurement methodology as k6 / hey / wrk:
 *
 *   - Fixed number of virtual users, each running requests back-to-back
 *     for T seconds.
 *   - Every request's wall-clock latency (Date.now around fetch)
 *     recorded in a preallocated Float64Array.
 *   - At the end: p50 / p90 / p95 / p99 / max via sorted quantile,
 *     throughput, error rate.
 *
 * Usage:
 *   node tools/loadtest/load.mjs \
 *     --url http://localhost:8080/api/v1/check \
 *     --method POST \
 *     --body '{"agent_id":"...", ...}' \
 *     --vus 50 \
 *     --duration 30 \
 *     --json
 *
 * The gateway's own `/metrics` histogram is scraped before + after so
 * the report can report both client-observed and server-reported p95.
 * Discrepancy = network + fetch-overhead — useful signal on its own.
 */

import { performance } from 'node:perf_hooks';
import { argv } from 'node:process';

// ── Args ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        args[k] = true;
      } else {
        args[k] = v;
        i++;
      }
    }
  }
  return args;
}

// Default /check payload — hits the hot policy path. Kept as a top-
// level const so the arg-defaults line below can reference it.
const DEFAULT_CHECK_BODY = JSON.stringify({
  agent_id:  '11111111-2222-3333-4444-555555555555',
  tool_name: 'noop',
  arguments: { label: 'loadtest' },
});

const args = parseArgs(argv);
const URL       = args.url      ?? 'http://localhost:8080/api/v1/check';
const METHOD    = args.method   ?? 'POST';
const BODY      = args.body     ?? DEFAULT_CHECK_BODY;
const VUS       = parseInt(args.vus      ?? '50',   10);
const DURATION  = parseInt(args.duration ?? '30',   10);
const WARMUP    = parseInt(args.warmup   ?? '2',    10);
const JSON_OUT  = Boolean(args.json);
const METRICS   = args.metrics  ?? URL.replace(/\/api\/v1\/.*$/, '/metrics');

// ── Latency store ──────────────────────────────────────────────────
//
// Preallocate a large buffer so we never resize mid-run — jitter from
// realloc would pollute the tail. 1M samples covers ~30k RPS × 30s
// with headroom; if we overflow we roll over and report the drop.

const MAX_SAMPLES = 2_000_000;
const latencies = new Float64Array(MAX_SAMPLES);
let n = 0, overflow = 0;
let ok = 0, err = 0;
const errStatus = new Map();

function record(latencyMs, status) {
  if (status >= 200 && status < 300) ok++;
  else {
    err++;
    errStatus.set(status, (errStatus.get(status) ?? 0) + 1);
  }
  if (n < MAX_SAMPLES) {
    latencies[n++] = latencyMs;
  } else {
    overflow++;
  }
}

// ── Worker ──────────────────────────────────────────────────────────

// Body templating: `{{uuid}}` gets substituted per request, so a
// single --body template lets ingest tests generate unique rows
// instead of colliding on a primary-key conflict. Cheap: single
// String.replace per hit.
const NEEDS_TEMPLATE = /\{\{uuid\}\}/.test(BODY);

function makeBody() {
  if (!NEEDS_TEMPLATE) return BODY;
  return BODY.replace(/\{\{uuid\}\}/g, crypto.randomUUID());
}

async function worker(deadline, url, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  while (performance.now() < deadline) {
    const t0 = performance.now();
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : makeBody(),
      });
      // Drain response body — some servers hold the socket open
      // otherwise, skewing latency of the next request.
      await res.arrayBuffer();
      record(performance.now() - t0, res.status);
    } catch (e) {
      record(performance.now() - t0, 0);   // 0 = network / abort
    }
  }
}

// ── Prometheus scraping ────────────────────────────────────────────
//
// Cheap parser — pulls a few named metrics without a full library.
// Reads count / sum / le buckets so we can compute server-observed
// p50 / p95 across the run.

async function scrapePrometheus(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function computeServerQuantile(prom, name, quantile) {
  if (!prom) return null;
  const buckets = new Map();
  let totalCount = 0;
  const bucketRe = new RegExp(`${name}_bucket\\{([^}]*)le="([^"]+)"[^}]*\\}\\s+(\\d+)`, 'g');
  const countRe  = new RegExp(`${name}_count\\{[^}]*\\}\\s+(\\d+)`, 'g');
  let m;
  while ((m = bucketRe.exec(prom))) {
    const le = m[2] === '+Inf' ? Infinity : Number(m[2]);
    const cnt = Number(m[3]);
    buckets.set(le, (buckets.get(le) ?? 0) + cnt);
  }
  while ((m = countRe.exec(prom))) totalCount += Number(m[1]);
  if (totalCount === 0) return null;
  const target = totalCount * quantile;
  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  for (const [le, cnt] of sorted) {
    if (cnt >= target) return le;
  }
  return null;
}

function diffServerQuantile(before, after, name, quantile) {
  const beforeCount = parsePromCount(before, name) ?? 0;
  const afterCount  = parsePromCount(after,  name) ?? 0;
  const delta = afterCount - beforeCount;
  if (delta === 0) return null;
  // Approximation — server histograms are counters so we compute the
  // bucket at the delta boundary. Not perfect but close enough for
  // p95 order-of-magnitude comparisons.
  const bucketRe = new RegExp(`${name}_bucket\\{([^}]*)le="([^"]+)"[^}]*\\}\\s+(\\d+)`, 'g');
  const beforeBuckets = new Map();
  const afterBuckets  = new Map();
  let m;
  while ((m = bucketRe.exec(before))) {
    const le = m[2] === '+Inf' ? Infinity : Number(m[2]);
    beforeBuckets.set(le, (beforeBuckets.get(le) ?? 0) + Number(m[3]));
  }
  while ((m = bucketRe.exec(after))) {
    const le = m[2] === '+Inf' ? Infinity : Number(m[2]);
    afterBuckets.set(le, (afterBuckets.get(le) ?? 0) + Number(m[3]));
  }
  const deltaBuckets = [...afterBuckets.entries()]
    .map(([le, cnt]) => [le, cnt - (beforeBuckets.get(le) ?? 0)])
    .filter(([, cnt]) => cnt > 0)
    .sort((a, b) => a[0] - b[0]);
  const target = delta * quantile;
  for (const [le, cnt] of deltaBuckets) {
    if (cnt >= target) return le;
  }
  return null;
}

function parsePromCount(prom, name) {
  if (!prom) return null;
  const re = new RegExp(`${name}_count\\{[^}]*\\}\\s+(\\d+)`, 'g');
  let total = 0;
  let m;
  while ((m = re.exec(prom))) total += Number(m[1]);
  return total;
}

// ── Quantile helpers ───────────────────────────────────────────────

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sorted.length) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  if (!JSON_OUT) {
    console.error(`▶ ${METHOD} ${URL}`);
    console.error(`  VUs=${VUS}  duration=${DURATION}s  warmup=${WARMUP}s`);
  }

  // Warmup — burn a few requests to fill v8's inline caches + DNS +
  // TLS handshake before we start counting.
  const warmupDeadline = performance.now() + WARMUP * 1000;
  await Promise.all(Array.from({ length: Math.min(4, VUS) }, () =>
    worker(warmupDeadline, URL, METHOD, BODY)));
  // Reset counters after warmup
  n = 0; ok = 0; err = 0; overflow = 0; errStatus.clear();

  const before = await scrapePrometheus(METRICS);

  const startWall = Date.now();
  const startPerf = performance.now();
  const deadline  = startPerf + DURATION * 1000;
  await Promise.all(Array.from({ length: VUS }, () =>
    worker(deadline, URL, METHOD, BODY)));
  const elapsedSec = (performance.now() - startPerf) / 1000;

  const after = await scrapePrometheus(METRICS);

  // Sort — Float64Array supports .sort()
  const sorted = latencies.slice(0, n);
  sorted.sort();

  const summary = {
    url: URL,
    method: METHOD,
    vus: VUS,
    duration_s: Number(elapsedSec.toFixed(2)),
    started_at: new Date(startWall).toISOString(),
    total_requests: n,
    overflow_samples_dropped: overflow,
    ok, err,
    error_status: Object.fromEntries(errStatus.entries()),
    throughput_rps: Number((n / elapsedSec).toFixed(1)),
    error_rate:     Number((err / Math.max(n, 1)).toFixed(4)),
    latency_ms: {
      p50:  Number(quantile(sorted, 0.50).toFixed(2)),
      p90:  Number(quantile(sorted, 0.90).toFixed(2)),
      p95:  Number(quantile(sorted, 0.95).toFixed(2)),
      p99:  Number(quantile(sorted, 0.99).toFixed(2)),
      p999: Number(quantile(sorted, 0.999).toFixed(2)),
      max:  Number(sorted[sorted.length - 1]?.toFixed(2) ?? 0),
      mean: Number((sorted.reduce((a, b) => a + b, 0) / Math.max(sorted.length, 1)).toFixed(2)),
    },
    server_p95_ms_delta: diffServerQuantile(before, after, 'aegis_http_request_duration_ms', 0.95),
    server_p50_ms_delta: diffServerQuantile(before, after, 'aegis_http_request_duration_ms', 0.50),
  };

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    console.error('');
    console.error(`  requests:      ${summary.total_requests.toLocaleString()} (${summary.ok} ok, ${summary.err} err)`);
    console.error(`  throughput:    ${summary.throughput_rps.toFixed(1)} rps`);
    console.error(`  error rate:    ${(summary.error_rate * 100).toFixed(2)}%${summary.err ? '  ' + JSON.stringify(summary.error_status) : ''}`);
    console.error(`  latency (ms):  p50=${summary.latency_ms.p50}  p95=${summary.latency_ms.p95}  p99=${summary.latency_ms.p99}  max=${summary.latency_ms.max}`);
    if (summary.server_p95_ms_delta !== null) {
      console.error(`  server p95:    ${summary.server_p95_ms_delta}ms  (bucket)`);
    }
  }
}

main().catch(e => {
  console.error('load test failed:', e);
  process.exit(1);
});
