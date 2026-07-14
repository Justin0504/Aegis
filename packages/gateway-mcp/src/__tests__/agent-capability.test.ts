/**
 * Capability attestation tests — verifies that an agent can only call
 * tools it declared at registration time. See
 * AgentRegistryService.checkCapability().
 */

import Database from 'better-sqlite3';
import pino from 'pino';
import { AgentRegistryService } from '../services/agent-registry';

function setup() {
  const db = new Database(':memory:');
  // Match the production schema exactly — schema-drift here means
  // production and tests diverge, which is worse than boilerplate.
  db.exec(`
    CREATE TABLE agents (
      id                   TEXT PRIMARY KEY,
      org_id               TEXT NOT NULL,
      name                 TEXT,
      description          TEXT,
      owner_email          TEXT,
      declared_tools       TEXT,
      max_cost_daily_usd   REAL,
      environments         TEXT,
      status               TEXT NOT NULL DEFAULT 'active',
      secret_hash          TEXT,
      public_key_pem       TEXT,
      capabilities         TEXT,
      provenance           TEXT,
      workflow_hash        TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at         TEXT
    );
  `);
  const svc = new AgentRegistryService(db, pino({ level: 'silent' }));
  return { db, svc };
}

describe('AgentRegistryService.checkCapability', () => {
  test('unregistered agent → allowed (nothing to enforce)', () => {
    const { svc } = setup();
    const r = svc.checkCapability({ agentId: 'ghost', toolName: 'stripe.refund' });
    expect(r.allowed).toBe(true);
  });

  test('no declared_tools set → allowed (opt-in enforcement)', () => {
    const { svc } = setup();
    svc.register({ orgId: 'o1', req: { id: 'a1', name: 'unrestricted' } });
    const r = svc.checkCapability({ agentId: 'a1', toolName: 'stripe.refund' });
    expect(r.allowed).toBe(true);
    expect(r.reason).toContain('no declared_tools');
  });

  test('exact tool name in declared_tools → allowed', () => {
    const { svc } = setup();
    svc.register({ orgId: 'o1', req: { id: 'a1', declared_tools: ['stripe.refund'] } });
    expect(svc.checkCapability({ agentId: 'a1', toolName: 'stripe.refund' }).allowed).toBe(true);
  });

  test('tool NOT in declared_tools → blocked with specific reason', () => {
    const { svc } = setup();
    svc.register({ orgId: 'o1', req: { id: 'a1', declared_tools: ['stripe.refund'] } });
    const r = svc.checkCapability({ agentId: 'a1', toolName: 'stripe.charge' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('stripe.charge');
    expect(r.reason).toContain('declared_tools');
  });

  test('wildcard suffix stripe.* → matches stripe.refund and stripe.charge', () => {
    const { svc } = setup();
    svc.register({ orgId: 'o1', req: { id: 'a1', declared_tools: ['stripe.*'] } });
    expect(svc.checkCapability({ agentId: 'a1', toolName: 'stripe.refund' }).allowed).toBe(true);
    expect(svc.checkCapability({ agentId: 'a1', toolName: 'stripe.charge' }).allowed).toBe(true);
    // But NOT stripes.charge (different segment)
    expect(svc.checkCapability({ agentId: 'a1', toolName: 'circle.refund' }).allowed).toBe(false);
  });

  test('interior * is not a wildcard — treated as literal', () => {
    // Ensures the wildcard semantics never accidentally expand — an
    // entry like "foo.*.bar" matches literally "foo.*.bar" and nothing
    // else. Prevents typo-shadowing.
    const { svc } = setup();
    svc.register({ orgId: 'o1', req: { id: 'a1', declared_tools: ['foo.*.bar'] } });
    expect(svc.checkCapability({ agentId: 'a1', toolName: 'foo.x.bar' }).allowed).toBe(false);
    expect(svc.checkCapability({ agentId: 'a1', toolName: 'foo.*.bar' }).allowed).toBe(true);
  });

  test('multiple entries — the first match wins, none matches → block', () => {
    const { svc } = setup();
    svc.register({ orgId: 'o1', req: { id: 'a1',
      declared_tools: ['stripe.*', 'postgres.select', 'coinbase.*'] } });
    expect(svc.checkCapability({ agentId: 'a1', toolName: 'stripe.refund' }).allowed).toBe(true);
    expect(svc.checkCapability({ agentId: 'a1', toolName: 'postgres.select' }).allowed).toBe(true);
    expect(svc.checkCapability({ agentId: 'a1', toolName: 'coinbase.buy' }).allowed).toBe(true);
    expect(svc.checkCapability({ agentId: 'a1', toolName: 'postgres.delete' }).allowed).toBe(false);
    expect(svc.checkCapability({ agentId: 'a1', toolName: 'exec' }).allowed).toBe(false);
  });
});
