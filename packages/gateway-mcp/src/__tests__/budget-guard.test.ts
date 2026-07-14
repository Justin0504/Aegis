import Database from 'better-sqlite3';
import pino from 'pino';
import { BudgetGuardService } from '../services/budget-guard';
import { BudgetDetector } from '../detectors/built-in/budget-detector';
import { TenantConfigService } from '../services/tenant-config';
import { ConfigBus } from '../services/config-bus';
import { AuditLogService } from '../services/audit-log';
import { AgentRegistryService } from '../services/agent-registry';
import { DetectorContext } from '@agentguard/core-schema';

function setup(): { db: Database.Database; guard: BudgetGuardService; tc: TenantConfigService; detector: BudgetDetector } {
  const db = new Database(':memory:');
  // Minimum schema both services need.
  db.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT, slug TEXT, plan TEXT,
      settings TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT, user_id TEXT, user_email TEXT,
      action TEXT, resource_type TEXT, resource_id TEXT,
      details TEXT, ip_address TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE traces (
      trace_id TEXT PRIMARY KEY, agent_id TEXT, session_id TEXT,
      org_id TEXT, timestamp TEXT, cost_usd REAL,
      model TEXT, input_tokens INTEGER, output_tokens INTEGER
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      name TEXT, description TEXT, owner_email TEXT,
      declared_tools TEXT, max_cost_daily_usd REAL, environments TEXT,
      status TEXT NOT NULL DEFAULT 'unregistered',
      secret_hash TEXT, public_key_pem TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT,
      capabilities TEXT, provenance TEXT, workflow_hash TEXT
    );
    INSERT INTO organizations (id, name, slug, plan) VALUES ('default', 'd', 'd', 'community');
  `);
  const logger = pino({ level: 'silent' });
  const audit = new AuditLogService(db, logger);
  const bus = new ConfigBus(logger);
  const tc = new TenantConfigService(db, logger, bus, audit);
  tc.seedDefaults();
  const guard = new BudgetGuardService(db, tc, logger);
  const detector = new BudgetDetector(guard);
  return { db, guard, tc, detector };
}

function ctx(over: Partial<DetectorContext> = {}): DetectorContext {
  return {
    tool: { name: 'web_search', args: {} },
    agent: { id: 'agent-1' },
    tenant: { id: 'default' },
    ...over,
  };
}

describe('BudgetGuardService', () => {
  it('returns null when budget is not enabled', () => {
    const { guard } = setup();
    expect(guard.evaluate({ orgId: 'default' })).toBeNull();
  });

  it('aggregates spend across traces (SDK path) and audit (proxy path)', () => {
    const { db, guard, tc } = setup();
    tc.update('default', {
      budget: { enabled: true, dailyUsd: 10, warnAt: 0.8, action: 'block' },
    }, { userEmail: 't' });

    // SDK side trace rows.
    db.prepare(
      `INSERT INTO traces (trace_id, agent_id, org_id, timestamp, cost_usd, model) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)`,
    ).run('t1', 'agent-1', 'default', 1.5, 'gpt-4');
    db.prepare(
      `INSERT INTO traces (trace_id, agent_id, org_id, timestamp, cost_usd, model) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)`,
    ).run('t2', 'agent-1', 'default', 2.0, 'gpt-4');

    // Proxy side audit rows.
    db.prepare(
      `INSERT INTO admin_audit_log (org_id, action, resource_type, resource_id, details) VALUES (?, ?, ?, ?, ?)`,
    ).run('default', 'proxy.llm_call', 'trace', 'x1', JSON.stringify({
      proxy: { provider: 'openai', agent_id: 'agent-1' }, cost: { usd: 3.0 },
    }));

    const spent = guard.spendSince({ orgId: 'default', sinceIso: '1970-01-01' });
    expect(spent).toBeCloseTo(6.5, 2);
  });

  it('emits warn severity when spend crosses warnAt threshold', () => {
    const { db, guard, tc } = setup();
    tc.update('default', {
      budget: { enabled: true, dailyUsd: 10, warnAt: 0.5, action: 'warn' },
    }, { userEmail: 't' });
    db.prepare(
      `INSERT INTO traces (trace_id, agent_id, org_id, timestamp, cost_usd, model) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)`,
    ).run('t1', 'agent-1', 'default', 6.0, 'gpt-4');

    const d = guard.evaluate({ orgId: 'default', agentId: 'agent-1' })!;
    expect(d.worst).toBe('warn');
    expect(d.entries[0].fraction).toBeGreaterThanOrEqual(0.5);
  });

  it('emits critical severity when spend exceeds limit', () => {
    const { db, guard, tc } = setup();
    tc.update('default', {
      budget: { enabled: true, dailyUsd: 5, warnAt: 0.8, action: 'block' },
    }, { userEmail: 't' });
    db.prepare(
      `INSERT INTO traces (trace_id, agent_id, org_id, timestamp, cost_usd, model) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)`,
    ).run('t1', 'agent-1', 'default', 7.0, 'gpt-4');

    const d = guard.evaluate({ orgId: 'default', agentId: 'agent-1' })!;
    expect(d.worst).toBe('critical');
  });

  it('agent.max_cost_daily_usd overrides tenant-wide perAgentDailyUsd', () => {
    const { db, tc } = setup();
    const logger = pino({ level: 'silent' });
    const reg = new AgentRegistryService(db, logger);
    const guard = new BudgetGuardService(db, tc, logger, reg);

    // Tenant default: $100/day per agent
    tc.update('default', {
      budget: { enabled: true, perAgentDailyUsd: 100, warnAt: 0.8, action: 'block' },
    }, { userEmail: 't' });

    // Register a STRICTER agent at $1/day
    const strict = reg.register({ orgId: 'default', req: { id: 'strict-bot', name: 'strict' } });
    reg.update({ orgId: 'default', agentId: 'strict-bot', req: { max_cost_daily_usd: 1 } });

    // Spend $2 — well under tenant default, but over agent-specific limit
    db.prepare(
      `INSERT INTO traces (trace_id, agent_id, org_id, timestamp, cost_usd, model) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)`,
    ).run('t1', 'strict-bot', 'default', 2.0, 'gpt-4');

    const d = guard.evaluate({ orgId: 'default', agentId: 'strict-bot' })!;
    expect(d.worst).toBe('critical');
    expect(d.entries[0].limitUsd).toBe(1);   // agent override applied, not tenant 100
  });

  it('per-agent limit isolates one agent from another', () => {
    const { db, guard, tc } = setup();
    tc.update('default', {
      budget: { enabled: true, perAgentDailyUsd: 5, warnAt: 0.8, action: 'block' },
    }, { userEmail: 't' });
    db.prepare(
      `INSERT INTO traces (trace_id, agent_id, org_id, timestamp, cost_usd, model) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)`,
    ).run('t1', 'agent-burner', 'default', 10.0, 'gpt-4');

    // burner agent over budget
    const burner = guard.evaluate({ orgId: 'default', agentId: 'agent-burner' })!;
    expect(burner.worst).toBe('critical');

    // other agent fine
    const other = guard.evaluate({ orgId: 'default', agentId: 'agent-other' })!;
    expect(other.worst).toBe('ok');
  });
});

describe('BudgetDetector', () => {
  it('emits no signals when below all thresholds', () => {
    const { detector, tc } = setup();
    tc.update('default', {
      budget: { enabled: true, dailyUsd: 100, warnAt: 0.9, action: 'block' },
    }, { userEmail: 't' });
    expect(detector.evaluate(ctx())).toEqual([]);
  });

  it('emits critical signal with AAT-T8002 ontology when over hard limit', () => {
    const { db, detector, tc } = setup();
    tc.update('default', {
      budget: { enabled: true, dailyUsd: 1, warnAt: 0.5, action: 'block' },
    }, { userEmail: 't' });
    db.prepare(
      `INSERT INTO traces (trace_id, agent_id, org_id, timestamp, cost_usd, model) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)`,
    ).run('t1', 'agent-1', 'default', 2.0, 'gpt-4');

    const signals = detector.evaluate(ctx());
    expect(signals.length).toBe(1);
    expect(signals[0].severity).toBe('critical');
    expect(signals[0].category).toBe('budget.tenant-daily');
    expect(signals[0].ontology).toContain('AAT-T8002');
    expect(signals[0].evidence?.spent_usd).toBe(2.0);
  });

  it("action=log keeps severity at 'info' even when over limit", () => {
    const { db, detector, tc } = setup();
    tc.update('default', {
      budget: { enabled: true, dailyUsd: 1, warnAt: 0.5, action: 'log' },
    }, { userEmail: 't' });
    db.prepare(
      `INSERT INTO traces (trace_id, agent_id, org_id, timestamp, cost_usd, model) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)`,
    ).run('t1', 'agent-1', 'default', 5.0, 'gpt-4');

    const signals = detector.evaluate(ctx());
    expect(signals.length).toBe(1);
    expect(signals[0].severity).toBe('info');
  });

  it("declares coverage for AAT-T8002 (Budget / Cost Burndown)", () => {
    const { detector } = setup();
    expect(detector.coverage).toEqual(['AAT-T8002']);
  });
});
