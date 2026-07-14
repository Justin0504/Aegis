import Database from 'better-sqlite3';
import pino from 'pino';
import {
  AgentRegistryService,
  AgentFirstSightingEvent,
} from '../services/agent-registry';

function setup() {
  const db = new Database(':memory:');
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
      capabilities TEXT, provenance TEXT, workflow_hash TEXT
    );
  `);
  const svc = new AgentRegistryService(db, pino({ level: 'silent' }));
  return { svc, db };
}

function nextTick() {
  return new Promise<void>(r => setImmediate(r));
}

describe('AgentRegistryService first-sighting events', () => {
  it('emits agent.first_sighting exactly once per new agent', async () => {
    const { svc } = setup();
    const events: AgentFirstSightingEvent[] = [];
    svc.onFirstSighting(e => events.push(e));

    svc.touch({ orgId: 'org-1', agentId: 'agent-A' });
    svc.touch({ orgId: 'org-1', agentId: 'agent-A' });   // dup → no second event
    svc.touch({ orgId: 'org-1', agentId: 'agent-A' });
    svc.touch({ orgId: 'org-1', agentId: 'agent-B' });

    await nextTick();
    await nextTick();

    expect(events.length).toBe(2);
    expect(new Set(events.map(e => e.agentId))).toEqual(new Set(['agent-A', 'agent-B']));
    expect(events[0].orgId).toBe('org-1');
    expect(events[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('does NOT re-emit when an already-registered agent is touched', async () => {
    const { svc } = setup();
    svc.register({ orgId: 'org-1', req: { id: 'pre-existing' } });

    const events: AgentFirstSightingEvent[] = [];
    svc.onFirstSighting(e => events.push(e));

    svc.touch({ orgId: 'org-1', agentId: 'pre-existing' });
    await nextTick();
    await nextTick();
    expect(events).toHaveLength(0);
  });

  it('includes provenance in the event payload when SDK reported it', async () => {
    const { svc } = setup();
    const events: AgentFirstSightingEvent[] = [];
    svc.onFirstSighting(e => events.push(e));

    svc.touch({
      orgId: 'org-1',
      agentId: 'agent-with-prov',
      provenance: { build_artifact: 'sha256:abc', source_commit: 'deadbeef' },
    });
    await nextTick();
    await nextTick();

    expect(events).toHaveLength(1);
    expect(events[0].provenance).toEqual({
      build_artifact: 'sha256:abc',
      source_commit:  'deadbeef',
    });
  });

  it('unsubscribe() stops the listener from receiving further events', async () => {
    const { svc } = setup();
    const events: AgentFirstSightingEvent[] = [];
    const off = svc.onFirstSighting(e => events.push(e));

    svc.touch({ orgId: 'org-1', agentId: 'before-off' });
    await nextTick();
    await nextTick();
    expect(events).toHaveLength(1);

    off();
    svc.touch({ orgId: 'org-1', agentId: 'after-off' });
    await nextTick();
    await nextTick();
    expect(events).toHaveLength(1);
  });

  it('isolates events per org for downstream SSE filtering', async () => {
    const { svc } = setup();
    const events: AgentFirstSightingEvent[] = [];
    svc.onFirstSighting(e => events.push(e));

    svc.touch({ orgId: 'org-A', agentId: 'X' });
    svc.touch({ orgId: 'org-B', agentId: 'Y' });

    await nextTick();
    await nextTick();

    const byOrg = Object.fromEntries(events.map(e => [e.orgId, e.agentId]));
    expect(byOrg['org-A']).toBe('X');
    expect(byOrg['org-B']).toBe('Y');
  });
});
