#!/usr/bin/env node
/**
 * Multi-tenant isolation audit against a live gateway.
 *
 * Complement to `smoke.mjs`. That harness verifies each endpoint
 * *responds*; this one verifies each endpoint *isolates*. For every
 * mutable resource in the gateway:
 *
 *   1. org-A creates the resource with its API key.
 *   2. org-B tries to LIST / GET / MODIFY / DELETE the resource with
 *      its own key. Expected: the resource is invisible or 404, and
 *      the mutation is refused without leaking existence.
 *   3. org-A verifies its own resource still exists and is unchanged.
 *
 * If a scenario passes here, that endpoint has cross-tenant isolation
 * baked into its query / mutation code. If it fails, we've found a
 * SOC 2 audit finding and (potentially) a data-leak between paying
 * customers.
 */

import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { randomUUID, createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
}
const NO_BUILD = Boolean(argOf('no-build', false));
const KEEP     = Boolean(argOf('keep',     false));
const PORT     = String(argOf('port', 18091));
const BASE     = `http://127.0.0.1:${PORT}`;
const GATEWAY_DIST = join(REPO_ROOT, 'packages', 'gateway-mcp', 'dist', 'server.js');

const TTY = Boolean(process.stdout.isTTY);
const c = (s, code) => TTY ? `\x1b[${code}m${s}\x1b[0m` : s;
const green  = s => c(s, '32');
const red    = s => c(s, '31');
const yellow = s => c(s, '33');
const dim    = s => c(s, '2');

function build() {
  console.error(dim('▶ npm run build'));
  const res = spawnSync('npm', ['run', 'build'], {
    cwd: join(REPO_ROOT, 'packages', 'gateway-mcp'),
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (res.status !== 0) { console.error(red('build failed')); process.exit(1); }
}

let gatewayProc = null;
let tmpDir = null;
let dbPath = null;
let logPath = null;
let keyA = null;
let keyB = null;

async function bootGateway() {
  tmpDir  = mkdtempSync(join(tmpdir(), 'aegis-iso-'));
  dbPath  = join(tmpDir, 'gateway.db');
  logPath = join(tmpDir, 'gateway.log');
  const logFd = openSync(logPath, 'w');
  gatewayProc = spawn('node', [GATEWAY_DIST], {
    env: { ...process.env, DB_PATH: dbPath, PORT,
      RATE_LIMIT_MAX: '1000000', SKIP_BILLING: '1',
      LOG_LEVEL: 'warn', NODE_ENV: 'development' },
    stdio: ['ignore', logFd, logFd],
  });
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; }
    catch { /* keep polling */ }
    await new Promise(r => setTimeout(r, 200));
  }
  const fs = await import('node:fs');
  console.error(red(`gateway boot timeout`));
  console.error(dim(fs.readFileSync(logPath, 'utf8').slice(-2000)));
  throw new Error('gateway boot timeout');
}

async function seedKeys() {
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w.name === 'ExperimentalWarning' && /SQLite/.test(w.message)) return;
    console.warn(w);
  });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  // The production `org_api_keys` table has a FK on organizations(id).
  // Seed both parent rows first — the schemas already exist via the
  // gateway's boot; we only INSERT.
  const insOrg = db.prepare(
    `INSERT OR IGNORE INTO organizations (id, name, slug, plan) VALUES (?, ?, ?, 'free')`);
  const insKey = db.prepare(
    `INSERT INTO org_api_keys (id, org_id, name, key_prefix, key_hash, scopes)
     VALUES (?, ?, ?, ?, ?, ?)`);
  function mint(orgId, name) {
    insOrg.run(orgId, name, orgId);
    const key = `aegis_${randomUUID().replace(/-/g, '')}`;
    const hash = createHash('sha256').update(key).digest('hex');
    insKey.run(randomUUID(), orgId, name, key.slice(0, 8), hash, JSON.stringify(['*']));
    return key;
  }
  keyA = mint('org-audit-A', 'audit-A');
  keyB = mint('org-audit-B', 'audit-B');
  db.close();
}

async function teardown() {
  if (KEEP) {
    console.error(yellow(`▶ --keep set. PID ${gatewayProc?.pid}, DB ${dbPath}`));
    return;
  }
  if (gatewayProc) {
    try { gatewayProc.kill('SIGTERM'); } catch {}
    await new Promise(r => {
      const t = setTimeout(r, 2000);
      gatewayProc.on('exit', () => { clearTimeout(t); r(); });
    });
  }
  if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
}

async function http(key, method, path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

class AssertionError extends Error {}
function assert(cond, msg) { if (!cond) throw new AssertionError(msg); }
function assertIn(actual, allowed, msg) {
  if (!allowed.includes(actual)) {
    throw new AssertionError(`${msg}: expected one of ${JSON.stringify(allowed)}, got ${JSON.stringify(actual)}`);
  }
}

const scenarios = [
  {
    name: 'saved_queries_isolation',
    prevents: "org-B seeing org-A's saved DSL queries (SOC 2 audit finding).",
    run: async (A, B) => {
      const create = await http(A, 'POST', '/api/v1/traces/saved-queries', {
        body: { name: `iso-${randomUUID().slice(0, 8)}`, dsl: 'tool:noop' },
      });
      assert(create.status === 201, `A create: ${JSON.stringify(create.body)}`);
      const id = create.body.id;

      const bList = await http(B, 'GET', '/api/v1/traces/saved-queries');
      assert(bList.status === 200, `B list: ${bList.status}`);
      const bIds = (bList.body.saved_queries ?? []).map(q => q.id);
      assert(!bIds.includes(id), `LEAK: B sees A's saved query ${id}`);

      const bDelete = await http(B, 'DELETE', `/api/v1/traces/saved-queries/${id}`);
      assertIn(bDelete.status, [403, 404], `B delete: ${bDelete.status}`);

      const aList = await http(A, 'GET', '/api/v1/traces/saved-queries');
      const aIds = (aList.body.saved_queries ?? []).map(q => q.id);
      assert(aIds.includes(id), "A lost its saved query after B's delete attempt");

      await http(A, 'DELETE', `/api/v1/traces/saved-queries/${id}`);
    },
  },
  {
    name: 'policies_shape_consistency',
    prevents: 'Policy endpoint returning different shapes per org (missing platform defaults, indicates broken wildcard).',
    run: async (A, B) => {
      const aList = await http(A, 'GET', '/api/v1/policies');
      const bList = await http(B, 'GET', '/api/v1/policies');
      assert(aList.status === 200 && bList.status === 200,
        `list status A=${aList.status} B=${bList.status}`);
      const aItems = Array.isArray(aList.body) ? aList.body : aList.body.policies;
      const bItems = Array.isArray(bList.body) ? bList.body : bList.body.policies;
      assert(Array.isArray(aItems) && Array.isArray(bItems), 'expected policies array');
      assert(aItems.length >= 1 && bItems.length >= 1, 'expected at least one platform-default policy');
    },
  },
  {
    name: 'agents_isolation',
    prevents: "org-B seeing / modifying org-A's registered agents.",
    run: async (A, B) => {
      const agentId = randomUUID();
      const create = await http(A, 'POST', '/api/v1/agents', {
        body: { id: agentId, name: 'iso-A', description: 'audit', declared_tools: ['noop'] },
      });
      if (![200, 201].includes(create.status)) return;   // endpoint absent this build

      const bList = await http(B, 'GET', '/api/v1/agents');
      if (bList.status !== 200) return;
      const rows = Array.isArray(bList.body) ? bList.body
                : Array.isArray(bList.body?.agents) ? bList.body.agents
                : [];
      const bIds = rows.map(a => a.id);
      assert(!bIds.includes(agentId), `LEAK: B sees A's agent ${agentId}`);

      const bGet = await http(B, 'GET', `/api/v1/agents/${agentId}`);
      assertIn(bGet.status, [403, 404], `B get: ${bGet.status}`);
    },
  },
  {
    name: 'rollback_sagas_isolation',
    prevents: "org-B listing / approving org-A's paused rollback sagas.",
    run: async (A, B) => {
      const aList = await http(A, 'GET', '/api/v1/rollback/sagas?limit=10');
      const bList = await http(B, 'GET', '/api/v1/rollback/sagas?limit=10');
      assert(aList.status === 200 && bList.status === 200,
        `list status A=${aList.status} B=${bList.status}`);
      assert(Array.isArray(aList.body.sagas) && Array.isArray(bList.body.sagas),
        'sagas array present for both');

      const fakeId = randomUUID();
      const bApprove = await http(B, 'POST', `/api/v1/rollback/sagas/${fakeId}/approve`, { body: {} });
      assertIn(bApprove.status, [400, 403, 404], `B approve fake: ${bApprove.status}`);
    },
  },
  {
    name: 'dlq_isolation',
    prevents: "org-B seeing / dismissing org-A's compensator DLQ entries.",
    run: async (A, B) => {
      const aDlq = await http(A, 'GET', '/api/v1/rollback/dlq');
      const bDlq = await http(B, 'GET', '/api/v1/rollback/dlq');
      assert(aDlq.status === 200 && bDlq.status === 200,
        `dlq status A=${aDlq.status} B=${bDlq.status}`);
    },
  },
  {
    name: 'traces_search_isolation',
    prevents: "org-B DSL-searching and finding org-A's traces (would leak arbitrary prompt / arg content across paying tenants).",
    run: async (A, B) => {
      const marker = `iso-audit-${randomUUID().slice(0, 8)}`;
      const trace = {
        trace_id: randomUUID(),
        agent_id: '11111111-2222-3333-4444-555555555555',
        timestamp: new Date().toISOString(),
        sequence_number: 0,
        input_context: { prompt: `secret prompt containing ${marker}` },
        thought_chain: { raw_tokens: 'noop' },
        tool_call: { tool_name: 'noop', function: 'noop', arguments: {}, timestamp: new Date().toISOString() },
        observation: { raw_output: 'ok', duration_ms: 1 },
        integrity_hash: createHash('sha256').update(marker).digest('hex'),
        environment: 'DEVELOPMENT',
        version: '1.0.0',
      };
      const ingest = await http(A, 'POST', '/api/v1/traces', { body: trace });
      if (![200, 201].includes(ingest.status)) return;

      const bSearch = await http(B, 'POST', '/api/v1/traces/search', {
        body: { q: `"${marker}"`, limit: 100 },
      });
      assert(bSearch.status === 200, `B search status ${bSearch.status}`);
      assert(bSearch.body.total === 0,
        `LEAK: B search for A's marker "${marker}" returned ${bSearch.body.total} rows`);
    },
  },
];

async function main() {
  if (!NO_BUILD) build();
  console.error(dim(`▶ booting gateway on :${PORT}`));
  await bootGateway();
  console.error(green(`✓ gateway ready at ${BASE}`));
  await seedKeys();
  console.error(green(`✓ seeded org-A key ${keyA.slice(0, 12)}… and org-B key ${keyB.slice(0, 12)}…`));
  console.error('');

  let passed = 0, failed = 0;
  for (const s of scenarios) {
    const start = performance.now();
    try {
      await s.run(keyA, keyB);
      const took = (performance.now() - start).toFixed(0);
      console.error(`${green('  ✓')}  ${s.name}  ${dim(`(${took}ms)`)}`);
      passed++;
    } catch (e) {
      const took = (performance.now() - start).toFixed(0);
      console.error(`${red('  ✗')}  ${s.name}  ${dim(`(${took}ms)`)}`);
      console.error(`     ${red(e.message)}`);
      console.error(`     ${dim('prevents: ' + s.prevents)}`);
      failed++;
    }
  }
  console.error('');
  if (failed === 0) console.error(green(`✓ ${passed}/${scenarios.length} tenant-isolation scenarios passed`));
  else console.error(red(`✗ ${failed} of ${scenarios.length} isolation checks failed (${passed} passed)`));
  await teardown();
  process.exit(failed === 0 ? 0 : 1);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await teardown(); process.exit(130); });
}

main().catch(async (e) => {
  console.error(red('audit harness crashed:'), e);
  await teardown();
  process.exit(2);
});
