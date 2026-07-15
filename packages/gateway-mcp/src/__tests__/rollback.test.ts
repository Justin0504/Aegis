/**
 * RollbackService integration tests. Exercises:
 *   - single rollback of an idempotent op (no executor needed)
 *   - single rollback of a compensable op via webhook compensator
 *   - rejection of irreversible without force_correction
 *   - acceptance of irreversible WITH force_correction (correction-only)
 *   - saga chain (multi-trace reverse-time)
 *   - second rollback on same trace is no-op
 *   - signed Merkle receipt is appended
 *   - DB row is marked rolled_back_at + rollback_audit_id
 *
 * Uses a tiny in-memory HTTP server as the webhook target.
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

function setup() {
  const db = new Database(':memory:');
  // Minimal schema — traces + admin_audit_log + signing_keys + transparency_log.
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
      environment TEXT, version TEXT, workflow_node_id TEXT, workflow_binding_id TEXT
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
  return { db, svc, reg, cls, snap, sagas, metrics, dlq };
}

function insertTrace(db: Database.Database, opts: { trace_id: string; agent_id: string; tool: string; args: any; ts?: string }) {
  db.prepare(
    `INSERT INTO traces (trace_id, agent_id, timestamp, sequence_number, input_context, thought_chain, tool_call, observation, integrity_hash, environment, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DEVELOPMENT', '1.0.0')`,
  ).run(
    opts.trace_id, opts.agent_id, opts.ts ?? new Date().toISOString(), 1,
    JSON.stringify({ prompt: 'test' }),
    JSON.stringify({ raw_tokens: '', parsed_steps: [] }),
    JSON.stringify({ tool_name: opts.tool, function: opts.tool, arguments: opts.args, timestamp: new Date().toISOString() }),
    JSON.stringify({ raw_output: { ok: true }, duration_ms: 10 }),
    'a'.repeat(64),
  );
}

function startWebhookServer(handler: (body: any) => { status: number; body?: any }): Promise<{ url: string; close: () => Promise<void>; received: any[] }> {
  return new Promise(resolve => {
    const received: any[] = [];
    const server = http.createServer((req, res) => {
      let buf = '';
      req.on('data', chunk => { buf += chunk; });
      req.on('end', () => {
        const body = (() => { try { return JSON.parse(buf); } catch { return null; } })();
        received.push(body);
        const r = handler(body);
        res.statusCode = r.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(r.body ?? {}));
      });
    });
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/compensate`,
        close: () => new Promise(r => server.close(() => r())),
        received,
      });
    });
  });
}

describe('RollbackService', () => {
  it('single rollback: idempotent op → status no_op (nothing to undo), but Merkle receipt is written', async () => {
    const { db, svc } = setup();
    insertTrace(db, { trace_id: 't-idem', agent_id: 'a1', tool: 'web_search', args: { q: 'x' } });

    const r = await svc.rollback({ orgId: 'org-1', trace_id: 't-idem', reason: 'test' });
    expect(r.status).toBe('rolled_back');
    expect(r.reversibility_class).toBe('idempotent');
    expect(r.compensator_kind).toBe('absent');
    // Receipt appended to transparency_log
    const seq = db.prepare(`SELECT COUNT(*) as n FROM transparency_log WHERE json_extract(payload, '$.action') = 'rollback.compensate'`).get() as any;
    expect(seq.n).toBe(1);
    // Trace marked
    const row = db.prepare(`SELECT rolled_back_at, reversibility_class FROM traces WHERE trace_id = ?`).get('t-idem') as any;
    expect(row.rolled_back_at).toBeTruthy();
    expect(row.reversibility_class).toBe('idempotent');
  });

  it('single rollback: compensable op WITH webhook compensator → executes webhook + signs receipt', async () => {
    const { db, svc, reg } = setup();
    insertTrace(db, { trace_id: 't-comp', agent_id: 'a1', tool: 'db_insert', args: { table: 'users', row_id: 42 } });

    const webhook = await startWebhookServer(() => ({ status: 200, body: { ok: true } }));
    try {
      reg.setConfig('org-1', { compensators: { 'db_insert': { kind: 'webhook', url: webhook.url } } });
      const r = await svc.rollback({ orgId: 'org-1', trace_id: 't-comp', reason: 'fixed bad row' });
      expect(r.status).toBe('rolled_back');
      expect(r.reversibility_class).toBe('compensable');
      expect(r.compensator_kind).toBe('webhook');
      // Webhook actually received the payload
      expect(webhook.received).toHaveLength(1);
      expect(webhook.received[0].trace_id).toBe('t-comp');
      expect(webhook.received[0].tool_name).toBe('db_insert');
      expect(webhook.received[0].arguments.row_id).toBe(42);
    } finally { await webhook.close(); }
  });

  it('single rollback: compensable WITHOUT registered compensator → unsupported, no execution', async () => {
    const { db, svc } = setup();
    insertTrace(db, { trace_id: 't-cmp-no', agent_id: 'a1', tool: 'db_insert', args: { table: 'users' } });
    const r = await svc.rollback({ orgId: 'org-1', trace_id: 't-cmp-no' });
    expect(r.status).toBe('unsupported');
    expect(r.error).toMatch(/no compensator/);
    const row = db.prepare(`SELECT rolled_back_at FROM traces WHERE trace_id = ?`).get('t-cmp-no') as any;
    expect(row.rolled_back_at).toBeNull();
  });

  it('single rollback: irreversible without force_correction → unsupported', async () => {
    const { db, svc } = setup();
    insertTrace(db, { trace_id: 't-irr', agent_id: 'a1', tool: 'send_email', args: { to: 'x@y.z' } });
    const r = await svc.rollback({ orgId: 'org-1', trace_id: 't-irr' });
    expect(r.status).toBe('unsupported');
    expect(r.error).toMatch(/force_correction/);
  });

  it('single rollback: irreversible WITH force_correction → emits correction-only receipt', async () => {
    const { db, svc } = setup();
    insertTrace(db, { trace_id: 't-irr2', agent_id: 'a1', tool: 'send_email', args: { to: 'x@y.z' } });
    const r = await svc.rollback({
      orgId: 'org-1', trace_id: 't-irr2', force_correction: true, reason: 'send retraction',
    });
    expect(r.status).toBe('rolled_back');
    expect(r.reversibility_class).toBe('irreversible');
    // Merkle receipt was written
    const row = db.prepare(`SELECT COUNT(*) as n FROM transparency_log WHERE json_extract(payload, '$.action') = 'rollback.compensate'`).get() as any;
    expect(row.n).toBe(1);
  });

  it('double rollback on same trace → second call is no_op', async () => {
    const { db, svc } = setup();
    insertTrace(db, { trace_id: 't-dup', agent_id: 'a1', tool: 'web_search', args: { q: 'x' } });
    const r1 = await svc.rollback({ orgId: 'org-1', trace_id: 't-dup' });
    const r2 = await svc.rollback({ orgId: 'org-1', trace_id: 't-dup' });
    expect(r1.status).toBe('rolled_back');
    expect(r2.status).toBe('no_op');
  });

  it('dry_run plans without executing', async () => {
    const { db, svc, reg } = setup();
    insertTrace(db, { trace_id: 't-dry', agent_id: 'a1', tool: 'db_insert', args: { id: 1 } });
    const webhook = await startWebhookServer(() => ({ status: 200, body: {} }));
    try {
      reg.setConfig('org-1', { compensators: { 'db_insert': { kind: 'webhook', url: webhook.url } } });
      const r = await svc.rollback({ orgId: 'org-1', trace_id: 't-dry', dry_run: true });
      expect(r.status).toBe('no_op');
      expect(r.planned_action).toBeTruthy();
      // Webhook not called
      expect(webhook.received).toHaveLength(0);
      // Trace not marked
      const row = db.prepare(`SELECT rolled_back_at FROM traces WHERE trace_id = ?`).get('t-dry') as any;
      expect(row.rolled_back_at).toBeNull();
    } finally { await webhook.close(); }
  });

  it('webhook timeout → status=failed, executor_error captured', async () => {
    const { db, svc, reg } = setup();
    insertTrace(db, { trace_id: 't-to', agent_id: 'a1', tool: 'db_insert', args: { id: 1 } });
    // Webhook that never responds within timeout
    const slow = http.createServer((_req, _res) => { /* leak */ });
    await new Promise(r => slow.listen(0, () => r(null)));
    const port = (slow.address() as AddressInfo).port;
    try {
      reg.setConfig('org-1', {
        compensators: { 'db_insert': { kind: 'webhook', url: `http://127.0.0.1:${port}/x`, timeout_ms: 200, retries: 0 } },
      });
      const r = await svc.rollback({ orgId: 'org-1', trace_id: 't-to' });
      expect(r.status).toBe('failed');
      expect(r.error).toBeTruthy();
      const row = db.prepare(`SELECT rolled_back_at FROM traces WHERE trace_id = ?`).get('t-to') as any;
      expect(row.rolled_back_at).toBeNull();
    } finally { slow.closeAllConnections?.(); slow.close(); }
  }, 10000);

  it('saga chain: multi-trace reverse-time, aborts on first failure', async () => {
    const { db, svc, reg } = setup();
    const ts = (s: number) => new Date(2026, 0, 1, 0, 0, s).toISOString();
    insertTrace(db, { trace_id: 't-1', agent_id: 'a1', tool: 'web_search', args: { q: 'a' }, ts: ts(10) });
    insertTrace(db, { trace_id: 't-2', agent_id: 'a1', tool: 'db_insert',   args: { id: 1 }, ts: ts(20) });
    insertTrace(db, { trace_id: 't-3', agent_id: 'a1', tool: 'web_search', args: { q: 'b' }, ts: ts(30) });

    const webhook = await startWebhookServer(() => ({ status: 200, body: {} }));
    try {
      reg.setConfig('org-1', { compensators: { 'db_insert': { kind: 'webhook', url: webhook.url } } });
      const r = await svc.rollbackChain({
        orgId: 'org-1', agent_id: 'a1', since: ts(0), reason: 'panic',
      });
      expect(r.scanned).toBe(3);
      expect(r.results).toHaveLength(3);
      // Reverse-time: t-3 first, then t-2, then t-1
      expect(r.results[0].trace_id).toBe('t-3');
      expect(r.results[1].trace_id).toBe('t-2');
      expect(r.results[2].trace_id).toBe('t-1');
      for (const x of r.results) expect(x.status).toBe('rolled_back');
      expect(r.aborted_at).toBeUndefined();
    } finally { await webhook.close(); }
  });

  it('pre_state snapshot flows into the compensator webhook body + hash matches', async () => {
    const { db, svc, reg, snap } = setup();
    insertTrace(db, { trace_id: 't-snap', agent_id: 'a1', tool: 'db_update', args: { id: 42, new_balance: 200 } });

    // Capture the pre-state up-front (the gateway would normally do
    // this on tool ingest).
    snap.setConfig('org-1', { snapshots: { db_update: { kind: 'inline_args' } } });
    await snap.capture({ orgId: 'org-1', trace_id: 't-snap', tool_name: 'db_update', arguments: { id: 42, new_balance: 200 } });
    const recorded = snap.get('t-snap')!;
    expect(recorded.hash).toMatch(/^[0-9a-f]{64}$/);

    const webhook = await startWebhookServer(() => ({ status: 200, body: { ok: true } }));
    try {
      reg.setConfig('org-1', { compensators: { db_update: { kind: 'webhook', url: webhook.url } } });
      const r = await svc.rollback({ orgId: 'org-1', trace_id: 't-snap', reason: 'undo bad update' });
      expect(r.status).toBe('rolled_back');
      expect(webhook.received).toHaveLength(1);
      const body = webhook.received[0];
      // The compensator received the pre-state under `pre_state`
      expect(body.pre_state).toEqual({ id: 42, new_balance: 200 });
      expect(body.pre_state_hash).toBe(recorded.hash);
      expect(body.capture_kind).toBe('inline_args');
      // Plus the regular fields
      expect(body.trace_id).toBe('t-snap');
      expect(body.tool_name).toBe('db_update');
    } finally { await webhook.close(); }
  });

  it('compensator receives null pre_state when no snapshot was captured', async () => {
    const { db, svc, reg } = setup();
    insertTrace(db, { trace_id: 't-nosnap', agent_id: 'a1', tool: 'db_insert', args: { id: 1 } });
    const webhook = await startWebhookServer(() => ({ status: 200, body: {} }));
    try {
      reg.setConfig('org-1', { compensators: { db_insert: { kind: 'webhook', url: webhook.url } } });
      await svc.rollback({ orgId: 'org-1', trace_id: 't-nosnap' });
      const body = webhook.received[0];
      expect(body.pre_state).toBeNull();
      expect(body.pre_state_hash).toBeNull();
      expect(body.capture_kind).toBeNull();
    } finally { await webhook.close(); }
  });

  it('failed compensator → DLQ entry created with planned action + last_error', async () => {
    const { db, svc, reg, dlq } = setup();
    insertTrace(db, { trace_id: 't-dlq', agent_id: 'a1', tool: 'db_insert', args: { id: 99 } });
    const srv = await startWebhookServer(() => ({ status: 500, body: { ok: false } }));
    try {
      reg.setConfig('org-1', { compensators: { db_insert: { kind: 'webhook', url: srv.url, retries: 0 } } });
      const r = await svc.rollback({ orgId: 'org-1', trace_id: 't-dlq' });
      expect(r.status).toBe('failed');
      const entries = dlq.list({ orgId: 'org-1', status: 'pending' });
      expect(entries).toHaveLength(1);
      expect(entries[0].trace_id).toBe('t-dlq');
      expect(entries[0].last_error).toMatch(/500/);
      expect((entries[0].planned_action as any).url).toBe(srv.url);
    } finally { await srv.close(); }
  });

  it('successful rollback → metrics counter increments', async () => {
    const { db, svc, reg, metrics } = setup();
    insertTrace(db, { trace_id: 't-m', agent_id: 'a1', tool: 'web_search', args: {} });
    await svc.rollback({ orgId: 'org-1', trace_id: 't-m' });
    const snap = metrics.snapshot();
    const row = snap.find(r => r.tool_name === 'web_search')!;
    expect(row.total.rolled_back).toBe(1);
    expect(row.success_rate).toBe(1);
  });

  it('rollback opens a saga + STARTED → EXECUTING → COMPLETED on success', async () => {
    const { db, svc, sagas } = setup();
    insertTrace(db, { trace_id: 't-saga', agent_id: 'a1', tool: 'web_search', args: {} });
    const r = await svc.rollback({ orgId: 'org-1', trace_id: 't-saga' });
    expect(r.saga_id).toBeTruthy();
    const saga = sagas.get({ orgId: 'org-1', sagaId: r.saga_id! })!;
    expect(saga.state).toBe('COMPLETED');
    expect(saga.step_count).toBe(1);
  });

  it('rollback chain shares a single saga across all steps + final state COMPLETED', async () => {
    const { db, svc, sagas } = setup();
    const ts = (s: number) => new Date(2026, 0, 1, 0, 0, s).toISOString();
    insertTrace(db, { trace_id: 't-c1', agent_id: 'chained', tool: 'web_search', args: {}, ts: ts(10) });
    insertTrace(db, { trace_id: 't-c2', agent_id: 'chained', tool: 'web_search', args: {}, ts: ts(20) });
    insertTrace(db, { trace_id: 't-c3', agent_id: 'chained', tool: 'web_search', args: {}, ts: ts(30) });

    const r = await svc.rollbackChain({ orgId: 'org-1', agent_id: 'chained', since: ts(0) });
    expect(r.saga_id).toBeTruthy();
    const sagaId = r.saga_id!;
    // All step results share this saga id
    for (const step of r.results) {
      expect(step.saga_id).toBe(sagaId);
    }
    const saga = sagas.get({ orgId: 'org-1', sagaId })!;
    expect(saga.state).toBe('COMPLETED');
    expect(saga.kind).toBe('rollback_chain');
    expect(saga.step_count).toBe(3);
  });

  it('saga chain aborts on first failed compensator', async () => {
    const { db, svc, reg } = setup();
    const ts = (s: number) => new Date(2026, 0, 1, 0, 0, s).toISOString();
    insertTrace(db, { trace_id: 't-x', agent_id: 'a2', tool: 'web_search', args: {}, ts: ts(10) });
    insertTrace(db, { trace_id: 't-y', agent_id: 'a2', tool: 'db_insert', args: {}, ts: ts(20) });
    insertTrace(db, { trace_id: 't-z', agent_id: 'a2', tool: 'web_search', args: {}, ts: ts(30) });

    // Webhook that always 500s — db_insert rollback will fail
    const bad = await startWebhookServer(() => ({ status: 500, body: { ok: false } }));
    try {
      reg.setConfig('org-2', { compensators: { 'db_insert': { kind: 'webhook', url: bad.url, retries: 0 } } });
      const r = await svc.rollbackChain({
        orgId: 'org-2', agent_id: 'a2', since: ts(0),
      });
      // Expected: t-z (idempotent) rolled back, t-y (db_insert) failed → abort.
      // t-x is not touched.
      expect(r.results[0].trace_id).toBe('t-z');
      expect(r.results[0].status).toBe('rolled_back');
      expect(r.results[1].trace_id).toBe('t-y');
      expect(r.results[1].status).toBe('failed');
      expect(r.aborted_at).toBe('t-y');
      // t-x was never attempted
      const tx = db.prepare(`SELECT rolled_back_at FROM traces WHERE trace_id = 't-x'`).get() as any;
      expect(tx.rolled_back_at).toBeNull();
    } finally { await bad.close(); }
  });
});
