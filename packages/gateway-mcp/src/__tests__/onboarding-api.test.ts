import express from 'express';
import Database from 'better-sqlite3';
import pino from 'pino';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

import { AgentRegistryService } from '../services/agent-registry';
import { OnboardingAPI } from '../api/onboarding';

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
  `);
  const logger = pino({ level: 'silent' });
  const registry = new AgentRegistryService(db, logger);
  const app = express();
  app.use((req, _res, next) => { (req as any).orgId = 'org-test'; next(); });
  app.use('/api/v1/onboarding', new OnboardingAPI(registry, logger).router);
  return { app, registry };
}

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('OnboardingAPI', () => {
  let server: Server;
  let url: string;
  let registry: AgentRegistryService;

  beforeAll(async () => {
    const built = bootApp();
    registry = built.registry;
    const started = await listen(built.app);
    server = started.server;
    url = started.url;
  });
  afterAll(() => { server.close(); });

  it('GET /status reports has_agents=false on a fresh tenant', async () => {
    const res = await fetch(`${url}/api/v1/onboarding/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as { has_agents: boolean; agent_count: number };
    expect(body.has_agents).toBe(false);
    expect(body.agent_count).toBe(0);
  });

  it('GET /stream pushes ready then agent.first_sighting on first touch', async () => {
    const ac = new AbortController();
    const resPromise = fetch(`${url}/api/v1/onboarding/stream`, { signal: ac.signal });

    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.body).toBeTruthy();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const events: Array<{ event: string; data: any }> = [];

    const drain = async () => {
      while (events.length < 2) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let ev = 'message';
          const dataLines: string[] = [];
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length) {
            const raw = dataLines.join('\n');
            try { events.push({ event: ev, data: JSON.parse(raw) }) }
            catch { events.push({ event: ev, data: raw }) }
          }
        }
      }
    };

    // Hook off the read loop, then fire a touch from the test's main thread.
    const drainPromise = drain();
    await new Promise(r => setTimeout(r, 50));
    registry.touch({ orgId: 'org-test', agentId: 'sse-target' });
    await drainPromise;

    expect(events[0].event).toBe('ready');
    expect(events[0].data.org_id).toBe('org-test');
    expect(events[1].event).toBe('agent.first_sighting');
    expect(events[1].data.agentId).toBe('sse-target');
    expect(events[1].data.orgId).toBe('org-test');

    ac.abort();
  });

  it('filters first_sighting events by org_id', async () => {
    const ac = new AbortController();
    const res = await fetch(`${url}/api/v1/onboarding/stream`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const events: Array<{ event: string; data: any }> = [];

    const drainUntilEvent = async (predicate: (e: { event: string }) => boolean, deadlineMs: number) => {
      const deadline = Date.now() + deadlineMs;
      while (!events.some(predicate) && Date.now() < deadline) {
        const racer = Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>(r => setTimeout(() => r({ value: undefined, done: true }), 250)),
        ]);
        const { value, done } = await racer;
        if (done) continue;
        buf += decoder.decode(value!, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let ev = 'message';
          const dataLines: string[] = [];
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length) {
            try { events.push({ event: ev, data: JSON.parse(dataLines.join('\n')) }) }
            catch { events.push({ event: ev, data: dataLines.join('\n') }) }
          }
        }
      }
    };

    await drainUntilEvent(e => e.event === 'ready', 500);
    await new Promise(r => setTimeout(r, 30));
    registry.touch({ orgId: 'org-other', agentId: 'cross-tenant' });
    registry.touch({ orgId: 'org-test',  agentId: 'right-tenant' });
    await drainUntilEvent(e => e.event === 'agent.first_sighting', 1500);

    const sightings = events.filter(e => e.event === 'agent.first_sighting');
    expect(sightings.length).toBe(1);
    expect(sightings[0].data.agentId).toBe('right-tenant');

    ac.abort();
  });
});
