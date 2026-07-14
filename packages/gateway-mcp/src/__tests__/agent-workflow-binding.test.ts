/**
 * Tests for Phase 1.2 — workflow-hash binding on the agent registry.
 *
 * Every scenario asserts one of the four contract properties:
 *
 *   1. Persist  — register with workflow_hash → row keeps it,
 *                 subsequent get() returns it.
 *   2. Enforce  — bound row + mismatched sighting → blocked.
 *                 Bound row + matching sighting  → allowed.
 *   3. Opt-in   — no binding on the row → no enforcement even if the
 *                 sighting asserts a hash.
 *   4. Preserve — re-register without a hash keeps the old binding
 *                 (silent clear would open a downgrade attack).
 */
import Database from 'better-sqlite3';
import pino from 'pino';
import { AgentRegistryService } from '../services/agent-registry';

function setup() {
  const db = new Database(':memory:');
  // Mirrors the enterprise-schema agents table shape + workflow_hash
  // column (which lands via ALTER in the real migration path).
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      name TEXT, description TEXT, owner_email TEXT,
      declared_tools TEXT, max_cost_daily_usd REAL, environments TEXT,
      status TEXT NOT NULL DEFAULT 'unregistered',
      secret_hash TEXT, public_key_pem TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT,
      capabilities TEXT, provenance TEXT,
      workflow_hash TEXT
    );
  `);
  return { svc: new AgentRegistryService(db, pino({ level: 'silent' })), db };
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('agent registry · workflow-hash binding', () => {
  test('register persists a workflow_hash and get() returns it', () => {
    const { svc } = setup();
    const { agent } = svc.register({
      orgId: 'org-1',
      req: { id: 'wf-agent', workflow_hash: HASH_A },
    });
    expect(agent.workflow_hash).toBe(HASH_A);
    const fetched = svc.get('wf-agent');
    expect(fetched?.workflow_hash).toBe(HASH_A);
  });

  test('bound row · matching sighting → allowed', () => {
    const { svc } = setup();
    svc.register({ orgId: 'org-1', req: { id: 'wf-agent', workflow_hash: HASH_A } });
    const result = svc.authorize({
      orgId: 'org-1', agentId: 'wf-agent',
      presentedWorkflowHash: HASH_A,
    });
    expect(result?.blocked).toBe(false);
  });

  test('bound row · mismatched sighting → blocked with workflow_mismatch', () => {
    const { svc } = setup();
    svc.register({ orgId: 'org-1', req: { id: 'wf-agent', workflow_hash: HASH_A } });
    const result = svc.authorize({
      orgId: 'org-1', agentId: 'wf-agent',
      presentedWorkflowHash: HASH_B,
    });
    expect(result?.blocked).toBe(true);
    expect(result?.blockReason).toMatch(/workflow_mismatch/);
  });

  test('unbound row · sighting with hash → allowed (no enforcement)', () => {
    const { svc } = setup();
    svc.register({ orgId: 'org-1', req: { id: 'legacy-agent' } });   // no workflow_hash
    const result = svc.authorize({
      orgId: 'org-1', agentId: 'legacy-agent',
      presentedWorkflowHash: HASH_A,
    });
    expect(result?.blocked).toBe(false);
  });

  test('bound row · sighting without hash → allowed (staged rollout)', () => {
    // Staged rollout: operator has bound the workflow but the SDK
    // hasn't started asserting the header yet. Should not break
    // production traffic — enforcement kicks in when both sides
    // agree they're speaking Phase 1.2.
    const { svc } = setup();
    svc.register({ orgId: 'org-1', req: { id: 'wf-agent', workflow_hash: HASH_A } });
    const result = svc.authorize({
      orgId: 'org-1', agentId: 'wf-agent',
      /* no presentedWorkflowHash */
    });
    expect(result?.blocked).toBe(false);
  });

  test('re-register without workflow_hash preserves the old binding', () => {
    // Downgrade-attack defence: if the caller doesn't supply a hash on
    // re-register, we KEEP the existing binding rather than silently
    // clear it. Explicit clear via the update() path is a separate story.
    const { svc } = setup();
    svc.register({ orgId: 'org-1', req: { id: 'wf-agent', workflow_hash: HASH_A } });
    svc.register({
      orgId: 'org-1',
      req: { id: 'wf-agent', name: 'renamed-only' },  // no workflow_hash
    });
    expect(svc.get('wf-agent')?.workflow_hash).toBe(HASH_A);
  });

  test('re-register with a NEW hash rotates the binding', () => {
    const { svc } = setup();
    svc.register({ orgId: 'org-1', req: { id: 'wf-agent', workflow_hash: HASH_A } });
    svc.register({ orgId: 'org-1', req: { id: 'wf-agent', workflow_hash: HASH_B } });
    expect(svc.get('wf-agent')?.workflow_hash).toBe(HASH_B);
  });

  test('workflow_hash rejects malformed input at schema layer', async () => {
    // Belt-and-suspenders: the Zod schema on
    // AgentRegistrationRequestSchema requires 64-char lowercase hex.
    // Non-hex or wrong length must fail parse before hitting the DB.
    const { AgentRegistrationRequestSchema } = await import('@agentguard/core-schema');
    expect(() => AgentRegistrationRequestSchema.parse({ workflow_hash: 'not-hex' })).toThrow();
    expect(() => AgentRegistrationRequestSchema.parse({ workflow_hash: 'a'.repeat(63) })).toThrow();
    expect(() => AgentRegistrationRequestSchema.parse({ workflow_hash: 'A'.repeat(64) })).toThrow();   // uppercase
    expect(() => AgentRegistrationRequestSchema.parse({ workflow_hash: HASH_A })).not.toThrow();
  });
});
