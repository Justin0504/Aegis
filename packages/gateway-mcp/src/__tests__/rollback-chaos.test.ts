/**
 * Chaos tests for the rollback subsystem.
 *
 * The existing rollback.test.ts covers happy paths + basic error cases
 * (webhook timeout once, second rollback → no-op). This file covers
 * the production incidents that actually keep rollback demos from
 * shipping to buyers:
 *
 *   1. Webhook returns 500 forever → after retries exhaust, entry
 *      lands in the DLQ with the correct attempts_made count and the
 *      last_error captures the HTTP status.
 *   2. Webhook is flaky (2× 500 then 200) → the retry loop absorbs
 *      the transient failure and reports rolled_back with no DLQ.
 *   3. Same trace hit by K concurrent rollback() calls → exactly one
 *      fires the webhook, the other K-1 return no_op. Idempotency
 *      under concurrency is the crown-jewel demo — if it double-fires,
 *      a compensated Stripe refund runs twice and the buyer walks.
 *   4. Saga PAUSED_FOR_APPROVAL then a second transition attempt after
 *      approval → invalid-transition error propagates cleanly (not a
 *      500). Guards the cockpit's "approve then re-approve" click.
 *   5. Causal DAG with a hand-authored cycle in extraDeps → order
 *      still contains every trace, no drops. Guards the CYCLE_IN_
 *      DEPENDS_ON fallback that ships as a warning.
 *   6. DLQ dismiss idempotency → dismissing twice returns false the
 *      second time (guards a cockpit double-click).
 *
 * Every test asserts on observable state (result.status, DLQ row,
 * saga row), not internal counters — so refactors that keep the
 * contract intact don't break the tests.
 */

import Database from 'better-sqlite3';
import pino from 'pino';
import http from 'http';
import { AddressInfo } from 'net';

import { AuditLogService } from '../services/audit-log';
import { TransparencyLogService } from '../services/transparency-log';
import { SigningService } from '../services/signing';
import { RollbackService } from '../services/rollback';
import { ReversibilityClassifier } from '../services/reversibility';
import { CompensationRegistry } from '../services/compensation-registry';
import { SnapshotCaptureService } from '../services/snapshot-capture';
import { SagaService } from '../services/saga';
import { RollbackMetricsService } from '../services/rollback-metrics';
import { DlqService } from '../services/dlq';
import { topologicalRollbackOrder } from '../services/causal-rollback';

// ── Test harness ────────────────────────────────────────────────────

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE traces (
      trace_id TEXT PRIMARY KEY,
      parent_trace_id TEXT,
      agent_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      sequence_number INTEGER,
      input_context TEXT, thought_chain TEXT,
      tool_call TEXT, observation TEXT,
      integrity_hash TEXT NOT NULL,
      previous_hash TEXT,
      environment TEXT, version TEXT
    );
    CREATE TABLE admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      org_id TEXT, user_id TEXT, user_email TEXT,
      action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT,
      details TEXT, ip_address TEXT
    );
    CREATE TABLE gateway_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE transparency_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      leaf_hash TEXT NOT NULL,
      payload TEXT NOT NULL,
      source TEXT NOT NULL,
      org_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const logger = pino({ level: 'silent' });
  const signing = new SigningService(db, logger);
  const audit   = new AuditLogService(db, logger);
  const tlog    = new TransparencyLogService(db, signing, logger);
  const reg     = new CompensationRegistry(logger);
  const cls     = new ReversibilityClassifier();
  const snap    = new SnapshotCaptureService(db, logger);
  const sagas   = new SagaService(db, logger);
  const metrics = new RollbackMetricsService();
  const dlq     = new DlqService(db, logger);
  const svc     = new RollbackService(db, logger, audit, tlog, reg, cls, snap, sagas, metrics, dlq);
  return { db, svc, reg, sagas, dlq };
}

function insertTrace(db: Database.Database, id: string, tool = 'db_insert') {
  db.prepare(
    `INSERT INTO traces (trace_id, agent_id, timestamp, sequence_number, input_context, thought_chain, tool_call, observation, integrity_hash, environment, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DEVELOPMENT', '1.0.0')`,
  ).run(
    id, 'agent-1', new Date().toISOString(), 1,
    JSON.stringify({ prompt: 'test' }),
    JSON.stringify({ raw_tokens: '', parsed_steps: [] }),
    JSON.stringify({ tool_name: tool, function: tool, arguments: {}, timestamp: new Date().toISOString() }),
    JSON.stringify({ raw_output: { ok: true }, duration_ms: 10 }),
    'a'.repeat(64),
  );
}

/**
 * Programmable webhook target. `plan` is a queue of `{ status, body }`
 * responses; each request pops one. When empty, returns 200 by default
 * so a mismatched test doesn't hang.
 */
function startWebhook(plan: Array<{ status: number; body?: any; delayMs?: number }>): Promise<{
  url: string; close: () => Promise<void>; received: any[]; hits: () => number;
}> {
  return new Promise(resolve => {
    const received: any[] = [];
    const queue = [...plan];
    const server = http.createServer((req, res) => {
      let buf = '';
      req.on('data', c => { buf += c; });
      req.on('end', async () => {
        const body = (() => { try { return JSON.parse(buf); } catch { return null; } })();
        received.push(body);
        const next = queue.shift() ?? { status: 200, body: {} };
        if (next.delayMs) await new Promise(r => setTimeout(r, next.delayMs));
        res.statusCode = next.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(next.body ?? {}));
      });
    });
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/compensate`,
        close: () => new Promise(r => server.close(() => r())),
        received,
        hits: () => received.length,
      });
    });
  });
}

// ── Chaos tests ─────────────────────────────────────────────────────

describe('rollback chaos', () => {
  it('webhook 500 forever → DLQ landing with correct attempts_made', async () => {
    const { db, svc, reg, dlq } = setup();
    // 10 x 500 in the plan — more than any retry budget can consume.
    const wh = await startWebhook(Array.from({ length: 10 }, () => ({ status: 500, body: { err: 'boom' } })));
    try {
      insertTrace(db, 't-fail');
      reg.setConfig('org-1', { compensators: { 'db_insert': {
        kind: 'webhook', url: wh.url, retries: 2, timeout_ms: 500,
      }}});

      const r = await svc.rollback({ orgId: 'org-1', trace_id: 't-fail', reason: 'chaos' });
      expect(r.status).toBe('failed');
      // retries: 2 means max attempts = 3
      expect(wh.hits()).toBe(3);

      const entries = dlq.list({ orgId: 'org-1' });
      expect(entries).toHaveLength(1);
      expect(entries[0].trace_id).toBe('t-fail');
      expect(entries[0].tool_name).toBe('db_insert');
      expect(entries[0].compensator_kind).toBe('webhook');
      expect(entries[0].attempts_made).toBe(3);
      expect(entries[0].last_error).toMatch(/500/);
      expect(entries[0].status).toBe('pending');
    } finally { await wh.close(); }
  });

  it('webhook flaky (2× 500 then 200) → retry absorbs it, no DLQ', async () => {
    const { db, svc, reg, dlq } = setup();
    const wh = await startWebhook([
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 200, body: { ok: true } },
    ]);
    try {
      insertTrace(db, 't-flaky');
      reg.setConfig('org-1', { compensators: { 'db_insert': {
        kind: 'webhook', url: wh.url, retries: 2, timeout_ms: 500,
      }}});

      const r = await svc.rollback({ orgId: 'org-1', trace_id: 't-flaky', reason: 'chaos' });
      expect(r.status).toBe('rolled_back');
      expect(wh.hits()).toBe(3);
      expect(dlq.list({ orgId: 'org-1' })).toHaveLength(0);
    } finally { await wh.close(); }
  });

  it('concurrent rollback() on same trace: only one executes, rest no-op', async () => {
    const { db, svc, reg, dlq } = setup();
    // Delay the webhook slightly so all K concurrent calls have a
    // chance to reach the check-and-fire path before the winner
    // marks the trace rolled_back.
    const wh = await startWebhook([{ status: 200, body: { ok: true }, delayMs: 50 }]);
    try {
      insertTrace(db, 't-concurrent');
      reg.setConfig('org-1', { compensators: { 'db_insert': {
        kind: 'webhook', url: wh.url, retries: 0, timeout_ms: 1000,
      }}});

      const K = 5;
      const results = await Promise.all(
        Array.from({ length: K }, () =>
          svc.rollback({ orgId: 'org-1', trace_id: 't-concurrent', reason: 'race' })),
      );

      const rolledBack = results.filter(r => r.status === 'rolled_back');
      const noOp       = results.filter(r => r.status === 'no_op');
      // Exactly one winner. The rest observed the already-rolled-back
      // trace and returned no_op — that's the idempotency contract.
      expect(rolledBack).toHaveLength(1);
      expect(noOp).toHaveLength(K - 1);
      // Webhook should have fired exactly once — the crown-jewel guard
      // (a Stripe refund should not run K times).
      expect(wh.hits()).toBe(1);
      expect(dlq.list({ orgId: 'org-1' })).toHaveLength(0);
    } finally { await wh.close(); }
  });

  it('saga transition after terminal state → invalid-transition error propagates', async () => {
    const { sagas } = setup();
    const sagaId = sagas.open({ orgId: 'org-1', kind: 'rollback_single', reason: 'test' });
    sagas.transition({ orgId: 'org-1', sagaId, to: 'EXECUTING' });
    sagas.transition({ orgId: 'org-1', sagaId, to: 'COMPLETED' });
    // Re-approve after terminal state — should throw a clear message,
    // NOT crash the process with an unhandled promise rejection.
    expect(() => sagas.transition({ orgId: 'org-1', sagaId, to: 'EXECUTING' })).toThrow(/invalid/i);
    // Also confirm state is preserved — the erroneous call didn't
    // mutate anything.
    expect(sagas.get({ orgId: 'org-1', sagaId })?.state).toBe('COMPLETED');
  });

  it('causal DAG cycle in extraDeps: order still complete, warning fires', async () => {
    // A depends on B, B depends on A — Kahn's algorithm can't sort.
    // The fallback must include BOTH traces (never silently drop) and
    // MUST fire the CYCLE_IN_DEPENDS_ON warning so an operator sees
    // it in gateway logs.
    const traces = [
      { trace_id: 'A', parent_trace_id: null, timestamp: '2026-07-08T10:00:00Z' },
      { trace_id: 'B', parent_trace_id: null, timestamp: '2026-07-08T10:00:01Z' },
    ];
    const deps = new Map([['A', ['B']], ['B', ['A']]]);
    const warnings: any[] = [];
    const order = topologicalRollbackOrder(traces, deps, (w) => warnings.push(w));
    expect(order.sort()).toEqual(['A', 'B']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('CYCLE_IN_DEPENDS_ON');
    expect(warnings[0].affected_trace_ids.sort()).toEqual(['A', 'B']);
  });

  it('DLQ dismiss is idempotent per row (second call returns false)', async () => {
    const { dlq } = setup();
    const id = dlq.enqueue({
      orgId: 'org-1', trace_id: 't-dlq', tool_name: 'x', compensator_kind: 'webhook',
      last_error: 'boom', attempts_made: 3, planned_action: {},
    });
    expect(dlq.dismiss({ orgId: 'org-1', id, actor: 'ops' })).toBe(true);
    // Second dismissal — the row is already resolved. Guards a
    // cockpit double-click, and cross-actor confusion.
    expect(dlq.dismiss({ orgId: 'org-1', id, actor: 'ops' })).toBe(false);
  });

  it('DLQ cross-tenant isolation: org-B cannot dismiss org-A\'s row', async () => {
    const { dlq } = setup();
    const id = dlq.enqueue({
      orgId: 'org-A', trace_id: 't-x', tool_name: 'y', compensator_kind: 'webhook',
      last_error: 'boom', attempts_made: 3, planned_action: {},
    });
    // Same id, wrong org — returns false without leaking existence.
    expect(dlq.dismiss({ orgId: 'org-B', id, actor: 'attacker' })).toBe(false);
    // And the row is still visible + pending for org-A.
    const entries = dlq.list({ orgId: 'org-A' });
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('pending');
  });

  it('webhook that times out mid-flight → retries respect timeout budget', async () => {
    const { db, svc, reg } = setup();
    // Webhook hangs for 2000ms; timeout_ms is 100ms so every attempt
    // times out. The final status must be `failed`, and total wall-
    // clock time must stay bounded (retries + backoff, not
    // retries × 2000ms).
    const wh = await startWebhook([
      { status: 200, body: {}, delayMs: 2000 },
      { status: 200, body: {}, delayMs: 2000 },
      { status: 200, body: {}, delayMs: 2000 },
    ]);
    try {
      insertTrace(db, 't-timeout');
      reg.setConfig('org-1', { compensators: { 'db_insert': {
        kind: 'webhook', url: wh.url, retries: 2, timeout_ms: 100,
      }}});

      const started = Date.now();
      const r = await svc.rollback({ orgId: 'org-1', trace_id: 't-timeout', reason: 'chaos' });
      const elapsed = Date.now() - started;

      expect(r.status).toBe('failed');
      // Sanity — 3 attempts × 100ms timeout + backoff (~250 + 500ms) ≈ well under 5s.
      // Anything closer to the hang duration (6s+) means timeout was ignored.
      expect(elapsed).toBeLessThan(5000);
    } finally { await wh.close(); }
  });
});
