import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import pino from 'pino';

import { ProxyHandler } from '../proxy/proxy-handler';
import { OpenAIChatAdapter } from '../proxy/adapters/openai-chat';
import { DetectorRegistry } from '../detectors/registry';
import { AuditLogService } from '../services/audit-log';
import { AgentRegistryService } from '../services/agent-registry';
import { AgentIdCardService } from '../services/agent-id-card';
import { SigningService } from '../services/signing';

function makeDb(): { db: Database.Database; aegisKey: string } {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT, user_id TEXT, user_email TEXT,
      action TEXT, resource_type TEXT, resource_id TEXT,
      details TEXT, ip_address TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE org_api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id TEXT, name TEXT, key_prefix TEXT, key_hash TEXT,
      scopes TEXT, rate_limit INTEGER,
      expires_at TEXT, revoked_at TEXT, last_used_at TEXT
    );
    CREATE TABLE gateway_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
  const aegisKey = 'aegis_test123';
  const hash = createHash('sha256').update(aegisKey).digest('hex');
  db.prepare(
    `INSERT INTO org_api_keys (org_id, name, key_prefix, key_hash, scopes) VALUES (?, ?, ?, ?, ?)`,
  ).run('default', 'test', 'aegis_te', hash, '[]');
  return { db, aegisKey };
}

function makeApp() {
  const { db, aegisKey } = makeDb();
  const logger = pino({ level: 'silent' });
  const audit = new AuditLogService(db, logger);
  const detectors = new DetectorRegistry({ logger });
  const registry = new AgentRegistryService(db, logger);
  const idCards = new AgentIdCardService(new SigningService(db, logger), registry);
  const handler = new ProxyHandler({
    db, logger, detectors, audit,
    adapters: [new OpenAIChatAdapter()],
    agentRegistry: registry,
    agentIdCards: idCards,
  });
  const app = express();
  app.use(express.json());
  app.all('/api/v1/llm-proxy/*', handler.handle);
  return { app, db, aegisKey, registry, idCards };
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

/** Only intercept api.openai.com so the test client can reach
 *  127.0.0.1 normally. */
function mockOpenAi(impl: (init: RequestInit) => Promise<Response>): jest.SpyInstance {
  const realFetch = globalThis.fetch.bind(globalThis);
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : String(input);
    if (u.startsWith('https://api.openai.com')) return impl(init ?? {});
    return realFetch(input, init);
  });
}

afterEach(() => jest.restoreAllMocks());

describe('Proxy JWT auth path', () => {
  it('accepts a valid JWT and resolves agent identity from sub claim', async () => {
    const { app, aegisKey, registry, idCards } = makeApp();
    const reg = registry.register({ orgId: 'default', req: { name: 'jwt-bot', issue_secret: false } });
    const minted = idCards.mint({ orgId: 'default', agentId: reg.agent.id })!;

    let upstreamHeaders: Record<string, string> = {};
    mockOpenAi(async (init) => {
      upstreamHeaders = (init.headers as Record<string, string>) || {};
      return new Response(JSON.stringify({
        id: 'x', model: 'gpt-4',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200 });
    });

    const { url, close } = await listen(app);
    try {
      const r = await fetch(`${url}/api/v1/llm-proxy/openai/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-aegis-key': aegisKey,
          // NOTE: deliberately use the WRONG agent id in the header to
          // prove the proxy ignores it when a JWT is present.
          'x-aegis-agent-id': 'spoofed-id',
          'x-aegis-agent-token': minted.token,
          'authorization': 'Bearer sk-test',
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(r.status).toBe(200);
      // Upstream MUST NOT see the JWT.
      expect(upstreamHeaders['x-aegis-agent-token']).toBeUndefined();
      expect(upstreamHeaders.authorization).toBe('Bearer sk-test');
    } finally { close(); }
  });

  it('rejects a tampered JWT with 403 AGENT_TOKEN_INVALID', async () => {
    const { app, aegisKey, registry, idCards } = makeApp();
    const reg = registry.register({ orgId: 'default', req: {} });
    const minted = idCards.mint({ orgId: 'default', agentId: reg.agent.id })!;
    // Flip one character in the signature → must fail verify.
    const [h, p, s] = minted.token.split('.');
    const tampered = `${h}.${p}.${s.slice(0, -2)}AA`;

    const { url, close } = await listen(app);
    try {
      const r = await fetch(`${url}/api/v1/llm-proxy/openai/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-aegis-key': aegisKey,
          'x-aegis-agent-token': tampered,
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });
      expect(r.status).toBe(403);
      const body = await r.json() as any;
      expect(body.error.code).toBe('AGENT_TOKEN_INVALID');
    } finally { close(); }
  });

  it('rejects a JWT for a suspended agent', async () => {
    const { app, aegisKey, registry, idCards } = makeApp();
    const reg = registry.register({ orgId: 'default', req: {} });
    const minted = idCards.mint({ orgId: 'default', agentId: reg.agent.id })!;
    registry.update({ orgId: 'default', agentId: reg.agent.id, req: { status: 'suspended' } });

    const { url, close } = await listen(app);
    try {
      const r = await fetch(`${url}/api/v1/llm-proxy/openai/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-aegis-key': aegisKey,
          'x-aegis-agent-token': minted.token,
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });
      expect(r.status).toBe(403);
      const body = await r.json() as any;
      expect(body.error.code).toBe('AGENT_TOKEN_INVALID');
      expect(body.error.message).toMatch(/suspended/);
    } finally { close(); }
  });

  it('JWT bypasses the agent-has-secret gate (strong proof of identity)', async () => {
    const { app, aegisKey, registry, idCards } = makeApp();
    // Register WITH a secret — then call without secret, with only JWT.
    const reg = registry.register({ orgId: 'default', req: { issue_secret: true } });
    const minted = idCards.mint({ orgId: 'default', agentId: reg.agent.id })!;

    mockOpenAi(async () => new Response(JSON.stringify({
      id: 'x', model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200 }));

    const { url, close } = await listen(app);
    try {
      const r = await fetch(`${url}/api/v1/llm-proxy/openai/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-aegis-key': aegisKey,
          'x-aegis-agent-token': minted.token,
          // NO x-aegis-agent-secret. Old auth path would have rejected.
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(r.status).toBe(200);
    } finally { close(); }
  });
});
