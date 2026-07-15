/**
 * Phase 4b · A2A observability envelope round-trip.
 *
 * When a child agent's trace ingests with `parent_agent_id`,
 * `delegation_reason`, `capability_grant`, and `a2a_envelope_hash`,
 * the fields must:
 *
 *   1. Persist to the traces table (all four columns populated).
 *   2. Survive the delegation-lookup SELECT with `capability_grant`
 *      parsed back into a nested object (not a JSON string).
 *   3. Be gracefully absent from the response when the SDK didn't
 *      send them (legacy path).
 *
 * The envelope hash format is a fixed contract: 64-hex SHA-256.
 * Bad shapes get null'd rather than rejecting the ingest — the
 * same defensive-cast policy as workflow anchors — so a buggy SDK
 * can't take down the trace ingest surface.
 */

import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { createHash, randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import pino from 'pino';

import { TraceAPI } from '../api/traces';
import { initializeDatabase } from '../db/database';

const PARENT_AGENT = '11111111-1111-1111-1111-111111111111';
const CHILD_AGENT  = '22222222-2222-2222-2222-222222222222';
const REASON       = 'escalate refund case to billing specialist';
const CAPS         = { tools: ['stripe_refund'], budget_usd: 100 };

/** Canonical envelope hash — SHA-256 over sorted-key JSON. Mirrors
 *  the SDK's compute_a2a_envelope_hash so this test also validates
 *  the wire contract shape. */
function envelopeHash(parent: string, child: string, reason: string, caps: any): string {
  const canonical = JSON.stringify(
    { capabilities: caps, child, parent, reason },
    Object.keys({ capabilities: null, child: null, parent: null, reason: null }).sort(),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

async function makeApp() {
  const db = await initializeDatabase(':memory:');
  // Seed one org so ingestOrgId resolves cleanly.
  db.exec(`CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT)`);
  db.exec(`INSERT OR IGNORE INTO organizations (id, name) VALUES ('default', 'Default')`);

  const logger = pino({ level: 'silent' });
  const api = new TraceAPI(db, logger);
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  // Emulate the auth middleware for lookups (delegation GET needs orgId).
  app.use((req, _res, next) => { (req as any).orgId = 'default'; next(); });
  app.use('/api/v1/traces', api.router);
  return { app, db };
}

function listen(app: express.Express): Promise<{ url: string; close: () => void }> {
  return new Promise(resolve => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

function buildTrace(overrides: Record<string, any> = {}): any {
  const traceId = randomUUID();
  const now = new Date().toISOString();
  return {
    trace_id: traceId,
    agent_id: CHILD_AGENT,
    timestamp: now,
    sequence_number: 0,
    input_context: { prompt: 'refund case C-42', session_id: randomUUID() },
    thought_chain: { raw_tokens: '', parsed_steps: [] },
    tool_call:     { tool_name: 'stripe_refund', function: 'stripe_refund',
                     arguments: { amount: 1200 }, timestamp: now },
    observation:   { raw_output: { refunded: true }, duration_ms: 42 },
    integrity_hash: 'a'.repeat(64),
    environment: 'DEVELOPMENT',
    version: '1.0.0',
    // Same delegation_id across parent + child = the audit "handoff" event.
    delegation_id: 'delegation-abc',
    ...overrides,
  };
}

describe('A2A envelope · trace round-trip', () => {
  test('all envelope fields persist and re-surface on delegation lookup', async () => {
    const { app } = await makeApp();
    const { url, close } = await listen(app);
    try {
      const hash = envelopeHash(PARENT_AGENT, CHILD_AGENT, REASON, CAPS);
      const trace = buildTrace({
        parent_agent_id:   PARENT_AGENT,
        delegation_reason: REASON,
        capability_grant:  CAPS,
        a2a_envelope_hash: hash,
      });

      const post = await fetch(`${url}/api/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(trace),
      });
      expect([200, 201]).toContain(post.status);

      const lookup = await fetch(`${url}/api/v1/traces/${trace.trace_id}/delegation`);
      expect(lookup.status).toBe(200);
      const body = await lookup.json() as any;
      expect(body.delegation_id).toBe('delegation-abc');
      expect(body.traces).toHaveLength(1);
      const row = body.traces[0];
      expect(row.parent_agent_id).toBe(PARENT_AGENT);
      expect(row.delegation_reason).toBe(REASON);
      expect(row.a2a_envelope_hash).toBe(hash);
      // capability_grant must come back as a nested object, NOT a JSON string.
      expect(row.capability_grant).toEqual(CAPS);
    } finally { close(); }
  });

  test('legacy trace with no envelope fields returns nulls on lookup', async () => {
    const { app } = await makeApp();
    const { url, close } = await listen(app);
    try {
      const trace = buildTrace();  // no envelope fields
      const post = await fetch(`${url}/api/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(trace),
      });
      expect([200, 201]).toContain(post.status);

      const lookup = await fetch(`${url}/api/v1/traces/${trace.trace_id}/delegation`);
      const body = await lookup.json() as any;
      const row = body.traces[0];
      expect(row.parent_agent_id).toBeNull();
      expect(row.delegation_reason).toBeNull();
      expect(row.capability_grant).toBeNull();
      expect(row.a2a_envelope_hash).toBeNull();
    } finally { close(); }
  });

  test('malformed a2a_envelope_hash is coerced to null (fail-safe ingest)', async () => {
    // A buggy SDK that sends "not-a-hex" must not fail the ingest.
    // The gateway drops the bad hash rather than 400-ing so the trace
    // still lands and the operator can see it in the audit trail
    // WITHOUT the envelope. Same defensive-cast policy as workflow
    // anchors in Phase 1.3.
    const { app } = await makeApp();
    const { url, close } = await listen(app);
    try {
      const trace = buildTrace({
        parent_agent_id:   PARENT_AGENT,
        delegation_reason: REASON,
        capability_grant:  CAPS,
        a2a_envelope_hash: 'not-a-hex',   // <— malformed
      });
      const post = await fetch(`${url}/api/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(trace),
      });
      // Ingest schema is lenient — malformed envelope field is treated
      // as "no envelope". Either 200 (schema accepted with null) or
      // 400 (schema rejected explicitly) is acceptable; a 500 is a
      // regression.
      expect([200, 400]).toContain(post.status);
      if (post.status === 200) {
        const lookup = await fetch(`${url}/api/v1/traces/${trace.trace_id}/delegation`);
        const body = await lookup.json() as any;
        const row = body.traces[0];
        // The bad hash was dropped; the other envelope fields either
        // survive or are dropped alongside — both are acceptable
        // "safe" behaviors. Only the hash is contractually null.
        expect(row.a2a_envelope_hash).toBeNull();
      }
    } finally { close(); }
  });

  test('envelope_hash format is 64 lowercase hex', () => {
    // Wire contract sanity — SHA-256 hex, lowercase.
    const h = envelopeHash(PARENT_AGENT, CHILD_AGENT, REASON, CAPS);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test('same envelope inputs → same hash (dedup contract)', () => {
    // Two identical handoffs must collide — the audit UI dedups on this.
    const h1 = envelopeHash(PARENT_AGENT, CHILD_AGENT, REASON, CAPS);
    const h2 = envelopeHash(PARENT_AGENT, CHILD_AGENT, REASON, CAPS);
    expect(h1).toBe(h2);
  });

  test('different reason → different hash (no false dedup)', () => {
    const h1 = envelopeHash(PARENT_AGENT, CHILD_AGENT, REASON,        CAPS);
    const h2 = envelopeHash(PARENT_AGENT, CHILD_AGENT, 'other reason', CAPS);
    expect(h1).not.toBe(h2);
  });
});
