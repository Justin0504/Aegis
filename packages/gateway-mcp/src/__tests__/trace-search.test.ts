/**
 * Integration tests for POST /api/v1/traces/search + saved_queries.
 *
 * Uses an in-memory SQLite with the FTS5 virtual table + triggers,
 * seeds it with representative trace rows, and drives the TraceAPI
 * router via supertest. Covers:
 *
 *   - Field predicate returns matching traces
 *   - Free-text FTS returns traces whose prompt contains the phrase
 *   - Field-scoped FTS (prompt:"...")
 *   - Boolean composition (AND / OR / NOT / parens)
 *   - Risk ordered compare (risk:>MEDIUM)
 *   - JSON path predicate (@args.amount:>10000)
 *   - Malformed DSL returns 400 (not 500)
 *   - Saved queries CRUD lifecycle with cross-tenant isolation
 */
import Database from 'better-sqlite3';
import pino from 'pino';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';

import { initializeDatabase } from '../db/database';
import { TraceAPI } from '../api/traces';

// ── Test harness ────────────────────────────────────────────────────
//
// We call initializeDatabase(':memory:') to get a fully-migrated
// database that mirrors production schema — including the FTS5
// virtual table, triggers, and saved_queries. The test then owns the
// resulting Database handle directly for INSERTs.
async function makeServer(): Promise<{ base: string; db: Database.Database; close: () => Promise<void> }> {
  const db = await initializeDatabase(':memory:');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).orgId  = req.header('x-test-org')  ?? 'org-A';
    (req as any).userId = req.header('x-test-user') ?? 'test-user';
    next();
  });
  const api = new TraceAPI(db, pino({ level: 'silent' }));
  app.use('/api/v1/traces', api.router);
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    db,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

// Small fetch wrapper matching supertest's ergonomics.
async function req(
  base: string, method: string, path: string,
  opts: { body?: any; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

/**
 * Insert a trace row directly. The trigger keeps traces_fts in sync
 * so the FTS index is populated for MATCH queries.
 */
function insertTrace(db: Database.Database, overrides: any = {}) {
  const now = new Date().toISOString();
  const row = {
    trace_id: overrides.trace_id ?? crypto.randomUUID(),
    parent_trace_id: null,
    delegation_id: null,
    parent_delegation_id: null,
    agent_id: overrides.agent_id ?? crypto.randomUUID(),
    timestamp: overrides.timestamp ?? now,
    sequence_number: overrides.sequence_number ?? 0,
    input_context:   JSON.stringify(overrides.input_context ?? { prompt: 'hello world' }),
    thought_chain:   JSON.stringify({ raw_tokens: 'noop' }),
    tool_call:       JSON.stringify(overrides.tool_call ?? {
      tool_name: 'noop', function: 'noop', arguments: {}, timestamp: now,
    }),
    observation:     JSON.stringify(overrides.observation ?? { raw_output: 'ok', duration_ms: 1 }),
    integrity_hash:  'a'.repeat(64),
    previous_hash:   null,
    signature:       null,
    safety_validation: overrides.safety_validation
      ? JSON.stringify(overrides.safety_validation) : null,
    approval_status: overrides.approval_status ?? null,
    approved_by:     null,
    environment:     'DEVELOPMENT',
    version:         '1.0.0',
    tags:            null,
    anomaly_score:   overrides.anomaly_score ?? 0,
    cost_usd:        overrides.cost_usd ?? 0,
  };

  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  db.prepare(`INSERT INTO traces (${cols.join(', ')}) VALUES (${placeholders})`)
    .run(...cols.map(k => (row as any)[k]));
}

// ── /search tests ───────────────────────────────────────────────────

describe('POST /api/v1/traces/search', () => {
  let harness: Awaited<ReturnType<typeof makeServer>>;
  beforeEach(async () => { harness = await makeServer(); });
  afterEach(async () => { await harness.close(); });

  test('field predicate: agent:X returns only that agent\'s traces', async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    insertTrace(harness.db, { agent_id: a });
    insertTrace(harness.db, { agent_id: a });
    insertTrace(harness.db, { agent_id: b });
    const r = await req(harness.base, 'POST', '/api/v1/traces/search', { body: { q: `agent:${a}` } });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.traces).toHaveLength(2);
  });

  test('free-text FTS matches on prompt', async () => {
    insertTrace(harness.db, { input_context: { prompt: 'refund 12345 to customer' } });
    insertTrace(harness.db, { input_context: { prompt: 'send email to boss' } });
    const r = await req(harness.base, 'POST', '/api/v1/traces/search', { body: { q: '"refund"' } });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.query.fts_match).toBe('"refund"');
  });

  test('field-scoped FTS: prompt:"phrase"', async () => {
    insertTrace(harness.db, { input_context: { prompt: 'the quick brown fox' } });
    insertTrace(harness.db, { input_context: { prompt: 'nothing to see here' } });
    const r = await req(harness.base, 'POST', '/api/v1/traces/search', { body: { q: 'prompt:"quick brown"' } });
    expect(r.body.total).toBe(1);
  });

  test('boolean composition: AND', async () => {
    const a = crypto.randomUUID();
    insertTrace(harness.db, { agent_id: a, tool_call: {
      tool_name: 'stripe_charge', function: 'f', arguments: {}, timestamp: new Date().toISOString(),
    }});
    insertTrace(harness.db, { agent_id: a, tool_call: {
      tool_name: 'send_email',    function: 'f', arguments: {}, timestamp: new Date().toISOString(),
    }});
    const r = await req(harness.base, 'POST', '/api/v1/traces/search', {
      body: { q: `agent:${a} AND tool:stripe_charge` },
    });
    expect(r.body.total).toBe(1);
  });

  test('boolean: NOT', async () => {
    insertTrace(harness.db, { tool_call: { tool_name: 'read_file',  function: 'f', arguments: {}, timestamp: new Date().toISOString() }});
    insertTrace(harness.db, { tool_call: { tool_name: 'write_file', function: 'f', arguments: {}, timestamp: new Date().toISOString() }});
    const r = await req(harness.base, 'POST', '/api/v1/traces/search', { body: { q: 'NOT tool:read_file' } });
    expect(r.body.total).toBe(1);
  });

  test('risk ordered compare risk:>MEDIUM matches HIGH + CRITICAL only', async () => {
    for (const level of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) {
      insertTrace(harness.db, { safety_validation: { policy_name: 'p', passed: false, risk_level: level }});
    }
    const r = await req(harness.base, 'POST', '/api/v1/traces/search', { body: { q: 'risk:>MEDIUM' } });
    expect(r.body.total).toBe(2);
  });

  test('JSON path @args.amount:>10000', async () => {
    insertTrace(harness.db, { tool_call: {
      tool_name: 'stripe_charge', function: 'f',
      arguments: { amount: 500, currency: 'usd' },
      timestamp: new Date().toISOString(),
    }});
    insertTrace(harness.db, { tool_call: {
      tool_name: 'stripe_charge', function: 'f',
      arguments: { amount: 50000, currency: 'usd' },
      timestamp: new Date().toISOString(),
    }});
    const r = await req(harness.base, 'POST', '/api/v1/traces/search', { body: { q: '@args.amount:>10000' } });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(1);
  });

  test('malformed DSL returns 400', async () => {
    const r = await req(harness.base, 'POST', '/api/v1/traces/search', { body: { q: 'nope:bad' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/unknown field/);
  });

  test('overlong DSL rejected before hitting compiler', async () => {
    const q = 'agent:foo '.repeat(1000);   // > 4096 chars
    const r = await req(harness.base, 'POST', '/api/v1/traces/search', { body: { q } });
    expect(r.status).toBe(400);
  });

  test('SQL injection attempt is caught by field whitelist', async () => {
    const r = await req(harness.base, 'POST', '/api/v1/traces/search', {
      body: { q: 'foo;DROP TABLE traces;--:bar' },
    });
    expect(r.status).toBe(400);
  });

  test('limit + offset pagination', async () => {
    for (let i = 0; i < 25; i++) insertTrace(harness.db);
    const r = await req(harness.base, 'POST', '/api/v1/traces/search', {
      body: { q: 'total_tokens:>=0', limit: 10, offset: 0 },
    });
    expect(r.status).toBe(200);
    expect(r.body.limit).toBe(10);
    expect(r.body.traces.length).toBeLessThanOrEqual(10);
    expect(r.body.total).toBe(25);
  });
});

// ── /saved-queries tests ────────────────────────────────────────────

describe('saved_queries lifecycle', () => {
  let harness: Awaited<ReturnType<typeof makeServer>>;
  beforeEach(async () => { harness = await makeServer(); });
  afterEach(async () => { await harness.close(); });

  test('POST + GET + DELETE round-trip', async () => {
    const create = await req(harness.base, 'POST', '/api/v1/traces/saved-queries', {
      body: { name: 'high-cost-stripe', dsl: 'tool:stripe_charge AND @args.amount:>10000' },
    });
    expect(create.status).toBe(201);
    expect(create.body.id).toBeTruthy();

    const list = await req(harness.base, 'GET', '/api/v1/traces/saved-queries');
    expect(list.status).toBe(200);
    expect(list.body.saved_queries.map((q: any) => q.name)).toContain('high-cost-stripe');

    const del = await req(harness.base, 'DELETE', `/api/v1/traces/saved-queries/${create.body.id}`);
    expect(del.status).toBe(204);

    const list2 = await req(harness.base, 'GET', '/api/v1/traces/saved-queries');
    expect(list2.body.saved_queries.map((q: any) => q.name)).not.toContain('high-cost-stripe');
  });

  test('refuses to save a query that does not compile', async () => {
    const r = await req(harness.base, 'POST', '/api/v1/traces/saved-queries', {
      body: { name: 'bad', dsl: 'not_a_real_field:xxx' },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/does not compile/);
  });

  test('cross-tenant isolation: org B cannot see org A\'s saved queries', async () => {
    const create = await req(harness.base, 'POST', '/api/v1/traces/saved-queries', {
      body: { name: 'org-A only', dsl: 'agent_id:foo' },
      headers: { 'x-test-org': 'org-A' },
    });
    expect(create.status).toBe(201);

    const listB = await req(harness.base, 'GET', '/api/v1/traces/saved-queries', {
      headers: { 'x-test-org': 'org-B' },
    });
    expect(listB.body.saved_queries.map((q: any) => q.name)).not.toContain('org-A only');
  });

  test('cross-tenant DELETE guarded by org_id', async () => {
    const create = await req(harness.base, 'POST', '/api/v1/traces/saved-queries', {
      body: { name: 'org-A only', dsl: 'agent_id:foo' },
      headers: { 'x-test-org': 'org-A' },
    });
    const delAsB = await req(harness.base, 'DELETE',
      `/api/v1/traces/saved-queries/${create.body.id}`,
      { headers: { 'x-test-org': 'org-B' } });
    expect(delAsB.status).toBe(404);
  });
});

