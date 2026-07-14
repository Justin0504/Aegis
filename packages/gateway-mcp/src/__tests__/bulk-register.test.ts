import express from 'express';
import Database from 'better-sqlite3';
import pino from 'pino';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

import { AgentRegistryService } from '../services/agent-registry';
import { AgentIdCardService } from '../services/agent-id-card';
import { SigningService } from '../services/signing';
import { AuditLogService } from '../services/audit-log';
import { AgentsAPI } from '../api/agents';

function bootApp() {
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
    CREATE TABLE admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      org_id TEXT, user_id TEXT, user_email TEXT,
      action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT,
      details TEXT, ip_address TEXT
    );
    CREATE TABLE gateway_config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const logger = pino({ level: 'silent' });
  const registry = new AgentRegistryService(db, logger);
  const signing  = new SigningService(db, logger);
  const idCards  = new AgentIdCardService(signing, registry);
  const audit    = new AuditLogService(db, logger);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => { (req as any).orgId = 'org-test'; next(); });
  app.use('/api/v1/agents', new AgentsAPI(db, logger, registry, audit, idCards).router);
  return { app, db };
}

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

describe('AgentsAPI.bulk_register', () => {
  let server: Server;
  let url: string;
  let db: Database.Database;

  beforeAll(async () => {
    const built = bootApp();
    db = built.db;
    const started = await listen(built.app);
    server = started.server;
    url = started.url;
  });
  afterAll(() => { server.close(); });

  it('registers every well-formed row and reports per-row success', async () => {
    const res = await fetch(`${url}/api/v1/agents/bulk-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agents: [
          { name: 'finance-bot',  source_file: 'svc/finance/main.py' },
          { name: 'research-bot', source_file: 'svc/research/main.py', owner_email: 'sre@acme.com' },
          { name: 'demo-bot',     source_file: 'demo/app.py' },
        ],
      }),
    });
    expect(res.status).toBe(207);
    const body = await res.json() as { requested: number; succeeded: number; results: any[] };
    expect(body.requested).toBe(3);
    expect(body.succeeded).toBe(3);
    expect(body.results).toHaveLength(3);
    for (const r of body.results) {
      expect(r.ok).toBe(true);
      expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    // Audit log: 3 user.create rows + 1 admin.bulk_register summary
    const userCreates = db.prepare(`SELECT COUNT(*) as n FROM admin_audit_log WHERE action = 'user.create' AND json_extract(details, '$.bulk') = 1`).get() as any;
    const summary    = db.prepare(`SELECT COUNT(*) as n FROM admin_audit_log WHERE action = 'admin.bulk_register'`).get() as any;
    expect(userCreates.n).toBe(3);
    expect(summary.n).toBe(1);
  });

  it('partial failure: bad rows reported, good rows still persisted', async () => {
    const res = await fetch(`${url}/api/v1/agents/bulk-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agents: [
          { name: 'good-agent' },
          { max_cost_daily_usd: 'not-a-number' },   // bad — Zod rejects
          { name: 'another-good-agent' },
        ],
      }),
    });
    expect(res.status).toBe(207);
    const body = await res.json() as { results: any[]; succeeded: number };
    expect(body.succeeded).toBe(2);
    expect(body.results[1].ok).toBe(false);
    expect(body.results[1].error).toBeTruthy();
  });

  it('rejects empty body.agents', async () => {
    const res = await fetch(`${url}/api/v1/agents/bulk-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agents: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects body.agents > 500', async () => {
    const agents = Array.from({ length: 501 }, (_, i) => ({ name: `bot-${i}` }));
    const res = await fetch(`${url}/api/v1/agents/bulk-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agents }),
    });
    expect(res.status).toBe(400);
  });

  it('idempotent on supplied id: re-registering promotes unregistered → active', async () => {
    const id = '00000000-0000-0000-0000-000000000abc';
    // First touch via the registry directly to simulate first-sighting
    db.prepare(`INSERT INTO agents (id, org_id, status) VALUES (?, 'org-test', 'unregistered')`).run(id);

    const res = await fetch(`${url}/api/v1/agents/bulk-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agents: [{ id, name: 'promoted', owner_email: 'a@b.com' }],
      }),
    });
    expect(res.status).toBe(207);
    const body = await res.json() as { results: any[] };
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].id).toBe(id);
    const row = db.prepare(`SELECT name, status FROM agents WHERE id = ?`).get(id) as any;
    expect(row.name).toBe('promoted');
    expect(row.status).toBe('active');
  });
});
