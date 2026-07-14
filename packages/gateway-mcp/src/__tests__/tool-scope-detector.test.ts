import Database from 'better-sqlite3';
import pino from 'pino';
import { AgentRegistryService } from '../services/agent-registry';
import { ToolScopeDetector } from '../detectors/built-in/tool-scope-detector';
import { DetectorContext } from '@agentguard/core-schema';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
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
  `);
  const logger = pino({ level: 'silent' });
  const reg = new AgentRegistryService(db, logger);
  const detector = new ToolScopeDetector(reg);
  return { reg, detector };
}

const ctx = (agentId: string, toolName: string): DetectorContext => ({
  tool: { name: toolName, args: {} },
  agent: { id: agentId },
  tenant: { id: 'default' },
});

describe('ToolScopeDetector', () => {
  it('quiet when agent is unregistered', () => {
    const { reg, detector } = setup();
    reg.touch({ orgId: 'default', agentId: 'unknown' });
    expect(detector.evaluate(ctx('unknown', 'anything'))).toEqual([]);
  });

  it('quiet when agent declared no tool scope', () => {
    const { reg, detector } = setup();
    reg.register({ orgId: 'default', req: { id: 'a-1', name: 'free' } });
    expect(detector.evaluate(ctx('a-1', 'web_search'))).toEqual([]);
  });

  it('quiet on tool that IS in declared scope', () => {
    const { reg, detector } = setup();
    reg.register({ orgId: 'default', req: { id: 'a-1', declared_tools: ['web_search', 'send_email'] } });
    expect(detector.evaluate(ctx('a-1', 'web_search'))).toEqual([]);
  });

  it('emits critical signal when out of declared scope', () => {
    const { reg, detector } = setup();
    reg.register({
      orgId: 'default',
      req: { id: 'a-1', name: 'data-bot', declared_tools: ['web_search', 'send_email'] },
    });
    const signals = detector.evaluate(ctx('a-1', 'run_query'));
    expect(signals.length).toBe(1);
    expect(signals[0].severity).toBe('critical');
    expect(signals[0].category).toBe('agent.out-of-scope-tool');
    expect(signals[0].ontology).toContain('AAT-T2001');
    expect(signals[0].ontology).toContain('AAT-T3001');
    expect(signals[0].message).toMatch(/run_query/);
    expect((signals[0].evidence as any).invoked_tool).toBe('run_query');
    expect((signals[0].evidence as any).declared_tools).toEqual(['web_search', 'send_email']);
  });

  it('declares coverage for AAT-T2001 + AAT-T3001', () => {
    const { detector } = setup();
    expect(detector.coverage).toEqual(['AAT-T2001', 'AAT-T3001']);
  });
});
