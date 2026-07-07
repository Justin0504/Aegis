#!/usr/bin/env node
/**
 * Load-test runner. Executes a suite of scenarios and emits a
 * PERFORMANCE.md at the repo root. Each scenario is a single call to
 * load.mjs — the runner just orchestrates + formats.
 *
 * Usage:
 *   node tools/loadtest/run.mjs               # default suite
 *   node tools/loadtest/run.mjs --duration 60 # override per-scenario duration
 *
 * The gateway must be running on http://localhost:8080 with a high
 * rate-limit ceiling. In this repo:
 *   lsof -ti :8080 | xargs kill -9
 *   RATE_LIMIT_MAX=100000 node packages/gateway-mcp/dist/server.js &
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const LOAD_SCRIPT = join(HERE, 'load.mjs');

const argv = process.argv.slice(2);
function argOf(key, fallback) {
  const i = argv.indexOf(`--${key}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const DURATION = argOf('duration', '30');
const WARMUP   = argOf('warmup',   '3');

// Scenarios are ordered by "hottest endpoint first" so the emitted
// tables read top-to-bottom in importance.
//
// /health is the baseline — an unrelated route that goes through the
// same middleware stack minus policy work, so p95 there tells us
// "how fast can express + our middleware move a packet."
//
// /api/v1/traces (POST) exercises the write path: JSON parse, Zod
// validate, SQLite insert + FTS5 trigger, transparency-log append.
// This is closest to real production write load.
//
// /api/v1/traces (GET) is the read path: query planner, SQLite scan.
// /api/v1/traces/search (POST) is the new DSL + FTS path.

const scenarios = [
  {
    name: 'baseline_health',
    label: 'Baseline · GET /health',
    args: ['--url', 'http://localhost:8080/health', '--method', 'GET'],
    vus_levels: [10, 50, 100],
  },
  {
    name: 'ingest_trace',
    label: 'Write · POST /api/v1/traces (unique rows)',
    args: [
      '--url', 'http://localhost:8080/api/v1/traces',
      '--method', 'POST',
      // {{uuid}} is substituted per request by load.mjs, so every hit
      // becomes a fresh INSERT — closest we can get to real prod
      // write load without a template engine.
      '--body', JSON.stringify({
        trace_id: '{{uuid}}',
        agent_id: '11111111-2222-3333-4444-555555555555',
        timestamp: new Date().toISOString(),
        sequence_number: 0,
        input_context:   { prompt: 'loadtest' },
        thought_chain:   { raw_tokens: 'x' },
        tool_call:       { tool_name: 'noop', function: 'noop', arguments: {}, timestamp: new Date().toISOString() },
        observation:     { raw_output: 'ok', duration_ms: 1 },
        integrity_hash:  'a'.repeat(64),
        environment:     'DEVELOPMENT',
        version:         '1.0.0',
      }),
    ],
    vus_levels: [10, 50],
  },
  {
    name: 'search_trace',
    label: 'Read · POST /api/v1/traces/search',
    args: [
      '--url', 'http://localhost:8080/api/v1/traces/search',
      '--method', 'POST',
      '--body', JSON.stringify({
        q: 'tool:noop AND @args.label:loadtest',
        limit: 100,
      }),
    ],
    vus_levels: [10, 50],
  },
];

function runOne(scenario, vus) {
  const args = [LOAD_SCRIPT, ...scenario.args, '--vus', String(vus), '--duration', DURATION, '--warmup', WARMUP, '--json'];
  const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`scenario ${scenario.name} @ vus=${vus} failed:`, res.stderr);
    throw new Error(`scenario failed`);
  }
  return JSON.parse(res.stdout);
}

function fmt(ms) {
  return ms.toFixed(2);
}

function generateMarkdown(results, meta) {
  const lines = [];
  lines.push('# AEGIS Gateway — Performance');
  lines.push('');
  lines.push(`> Generated: ${meta.at}`);
  lines.push(`> Machine: ${meta.machine}`);
  lines.push(`> Node: ${meta.node}`);
  lines.push(`> Per-scenario duration: ${meta.duration}s (warmup ${meta.warmup}s)`);
  lines.push('');
  lines.push('Client is `tools/loadtest/load.mjs` — Node built-in fetch, fixed VU pool, all VUs sending back-to-back for the full duration. Latencies measured client-side (wall-clock around fetch); server-side p95 pulled from the gateway\'s Prometheus histogram delta over the run.');
  lines.push('');
  lines.push('The numbers below are what a single-instance gateway on a MacBook can sustain today. Horizontally-scaled deployments (Docker + load balancer) will be linear in instance count for read paths, sublinear for writes (SQLite contention).');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Scenario | VUs | Throughput (rps) | p50 | p95 | p99 | Errors |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const { scenario, vus, result } of results) {
    lines.push(`| ${scenario.label} | ${vus} | ${result.throughput_rps.toFixed(0)} | ${fmt(result.latency_ms.p50)}ms | ${fmt(result.latency_ms.p95)}ms | ${fmt(result.latency_ms.p99)}ms | ${(result.error_rate * 100).toFixed(2)}% |`);
  }
  lines.push('');
  lines.push('## Notes per scenario');
  lines.push('');
  const seen = new Set();
  for (const { scenario } of results) {
    if (seen.has(scenario.name)) continue;
    seen.add(scenario.name);
    lines.push(`### ${scenario.label}`);
    lines.push('');
    lines.push(`- **Endpoint:** \`${scenario.args[scenario.args.indexOf('--method') + 1] ?? 'GET'} ${scenario.args[scenario.args.indexOf('--url') + 1]}\``);
    if (scenario.caveat) lines.push(`- **Caveat:** ${scenario.caveat}`);
    lines.push('');
  }
  lines.push('## Reproducing');
  lines.push('');
  lines.push('```bash');
  lines.push('# Kill any existing gateway; start with a high rate-limit ceiling');
  lines.push('lsof -ti :8080 | xargs kill -9');
  lines.push('cd packages/gateway-mcp && RATE_LIMIT_MAX=100000 node dist/server.js &');
  lines.push('');
  lines.push('# Run the full suite (writes PERFORMANCE.md)');
  lines.push('node tools/loadtest/run.mjs');
  lines.push('');
  lines.push('# Or a single scenario');
  lines.push('node tools/loadtest/load.mjs --url http://localhost:8080/health --method GET --vus 50 --duration 30');
  lines.push('```');
  lines.push('');
  lines.push('## Raw results');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(results.map(r => ({ scenario: r.scenario.name, vus: r.vus, ...r.result })), null, 2));
  lines.push('```');
  return lines.join('\n') + '\n';
}

async function main() {
  const results = [];
  for (const scenario of scenarios) {
    for (const vus of scenario.vus_levels) {
      const label = `${scenario.name} @ vus=${vus}`;
      process.stderr.write(`▶ ${label}...\n`);
      const result = runOne(scenario, vus);
      process.stderr.write(`  ${result.throughput_rps.toFixed(0)} rps, p95=${result.latency_ms.p95}ms, err=${(result.error_rate * 100).toFixed(2)}%\n`);
      results.push({ scenario, vus, result });
    }
  }

  const meta = {
    at:       new Date().toISOString(),
    machine:  `${process.platform} ${process.arch}`,
    node:     process.version,
    duration: DURATION,
    warmup:   WARMUP,
  };
  const md = generateMarkdown(results, meta);
  const out = join(REPO_ROOT, 'PERFORMANCE.md');
  writeFileSync(out, md);
  process.stderr.write(`\n✓ wrote ${out}\n`);
}

main().catch(e => {
  console.error('runner failed:', e);
  process.exit(1);
});
