import Database from 'better-sqlite3';
import pino from 'pino';
import { AgentRegistryService } from '../services/agent-registry';

function setup() {
  const db = new Database(':memory:');
  // Subset of enterprise-schema needed for the registry tests.
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
  const logger = pino({ level: 'silent' });
  const svc = new AgentRegistryService(db, logger);
  return { svc, db };
}

describe('AgentRegistryService.register', () => {
  it('creates an active row with the supplied metadata', () => {
    const { svc } = setup();
    const out = svc.register({
      orgId: 'org-1',
      req: { name: 'data-bot', description: 'fetches feeds', owner_email: 'a@b.com' },
    });
    expect(out.agent.status).toBe('active');
    expect(out.agent.name).toBe('data-bot');
    expect(out.agent.org_id).toBe('org-1');
    expect(out.agent.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.secret).toBeUndefined();
  });

  it('returns plaintext secret on issue_secret=true; only hash stays', () => {
    const { svc, db } = setup();
    const out = svc.register({
      orgId: 'org-1',
      req: { issue_secret: true },
    });
    expect(out.secret).toMatch(/^aegis_a_/);
    expect(out.agent.has_secret).toBe(true);
    const row = db.prepare(`SELECT secret_hash FROM agents WHERE id = ?`).get(out.agent.id) as any;
    expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.secret_hash).not.toBe(out.secret);   // raw secret never lands in DB
  });

  it('promotes an existing unregistered row to active in-place', () => {
    const { svc, db } = setup();
    db.prepare(
      `INSERT INTO agents (id, org_id, status, last_seen_at) VALUES ('a-1', 'org-1', 'unregistered', datetime('now'))`,
    ).run();
    const out = svc.register({
      orgId: 'org-1',
      req: { id: 'a-1', name: 'promoted', declared_tools: ['web_search', 'send_email'] },
    });
    expect(out.agent.id).toBe('a-1');
    expect(out.agent.status).toBe('active');
    expect(out.agent.declared_tools).toEqual(['web_search', 'send_email']);
  });
});

describe('AgentRegistryService.touch', () => {
  it('auto-records first sighting as unregistered', () => {
    const { svc } = setup();
    svc.touch({ orgId: 'org-1', agentId: 'never-seen' });
    const agent = svc.get('never-seen');
    expect(agent?.status).toBe('unregistered');
    expect(agent?.last_seen_at).toBeDefined();
  });

  it('updates last_seen_at on every call', async () => {
    const { svc } = setup();
    svc.touch({ orgId: 'org-1', agentId: 'a' });
    const first = svc.get('a')!.last_seen_at;
    await new Promise(r => setTimeout(r, 1100));   // datetime('now') has 1s resolution
    svc.touch({ orgId: 'org-1', agentId: 'a' });
    const second = svc.get('a')!.last_seen_at;
    expect(second).not.toBe(first);
  });
});

describe('AgentRegistryService.authorize', () => {
  it('returns weak attribution for unregistered agents (backward compat)', () => {
    const { svc } = setup();
    const r = svc.authorize({ orgId: 'org-1', agentId: 'drive-by' })!;
    expect(r.blocked).toBe(false);
    expect(r.attributionStrength).toBe('weak');
    expect(r.agent.status).toBe('unregistered');
  });

  it('returns strong attribution for active registered agents', () => {
    const { svc } = setup();
    const reg = svc.register({ orgId: 'org-1', req: {} });
    const r = svc.authorize({ orgId: 'org-1', agentId: reg.agent.id })!;
    expect(r.blocked).toBe(false);
    expect(r.attributionStrength).toBe('strong');
  });

  it('blocks suspended agents', () => {
    const { svc } = setup();
    const reg = svc.register({ orgId: 'org-1', req: {} });
    svc.update({ orgId: 'org-1', agentId: reg.agent.id, req: { status: 'suspended' } });
    const r = svc.authorize({ orgId: 'org-1', agentId: reg.agent.id })!;
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toMatch(/suspended/);
  });

  it('blocks when secret required but missing', () => {
    const { svc } = setup();
    const reg = svc.register({ orgId: 'org-1', req: { issue_secret: true } });
    const r = svc.authorize({ orgId: 'org-1', agentId: reg.agent.id })!;
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toMatch(/secret required/);
  });

  it('blocks when secret presented is wrong', () => {
    const { svc } = setup();
    const reg = svc.register({ orgId: 'org-1', req: { issue_secret: true } });
    const r = svc.authorize({
      orgId: 'org-1',
      agentId: reg.agent.id,
      presentedSecret: 'aegis_a_NOT_THE_RIGHT_ONE',
    })!;
    expect(r.blocked).toBe(true);
    expect(r.blockReason).toMatch(/secret mismatch/);
  });

  it('passes when correct secret presented', () => {
    const { svc } = setup();
    const reg = svc.register({ orgId: 'org-1', req: { issue_secret: true } });
    const r = svc.authorize({
      orgId: 'org-1',
      agentId: reg.agent.id,
      presentedSecret: reg.secret!,
    })!;
    expect(r.blocked).toBe(false);
    expect(r.attributionStrength).toBe('strong');
  });
});

describe('AgentRegistryService.rotateSecret', () => {
  it('returns a new secret and invalidates the old one', () => {
    const { svc } = setup();
    const reg = svc.register({ orgId: 'org-1', req: { issue_secret: true } });
    const oldSecret = reg.secret!;
    const rotated = svc.rotateSecret({ orgId: 'org-1', agentId: reg.agent.id })!;
    expect(rotated.secret).not.toBe(oldSecret);

    const withOld = svc.authorize({ orgId: 'org-1', agentId: reg.agent.id, presentedSecret: oldSecret })!;
    expect(withOld.blocked).toBe(true);

    const withNew = svc.authorize({ orgId: 'org-1', agentId: reg.agent.id, presentedSecret: rotated.secret })!;
    expect(withNew.blocked).toBe(false);
  });
});

describe('AgentRegistryService.list / deregister', () => {
  it('excludes deprecated by default; includes when requested', () => {
    const { svc } = setup();
    const a = svc.register({ orgId: 'org-1', req: { name: 'active-a' } });
    const b = svc.register({ orgId: 'org-1', req: { name: 'to-be-gone' } });
    svc.deregister({ orgId: 'org-1', agentId: b.agent.id });

    const def = svc.list({ orgId: 'org-1' });
    expect(def.map(x => x.id)).toEqual([a.agent.id]);

    const all = svc.list({ orgId: 'org-1', includeDeprecated: true });
    expect(all.map(x => x.id).sort()).toEqual([a.agent.id, b.agent.id].sort());
  });

  it('isolates tenants', () => {
    const { svc } = setup();
    svc.register({ orgId: 'org-1', req: { name: 'one' } });
    svc.register({ orgId: 'org-2', req: { name: 'two' } });
    expect(svc.list({ orgId: 'org-1' }).map(x => x.name)).toEqual(['one']);
    expect(svc.list({ orgId: 'org-2' }).map(x => x.name)).toEqual(['two']);
  });
});
