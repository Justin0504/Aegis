/**
 * Phase 4a · DSL policy enforcement on the LLM egress proxy.
 *
 * Same DSL evaluator + context shape as /api/v1/check, so a policy
 * written once fires on both surfaces. This suite pins the wire:
 *
 *   1. DSL `block` on a pending tool_call → response is mangled
 *      (blocked-tool-call header + refusal content in the choices).
 *   2. DSL `pending` in the proxy path is treated as `block`
 *      (proxy can't hold for human approval on an inline HTTP call).
 *      The audit row must still carry the ORIGINAL decision so
 *      operators can see this was a pending-treated-as-block, not
 *      an outright block.
 *   3. DSL `allow` (no match) preserves detector-only behavior.
 *   4. Workflow anchor headers reach the evaluator — a rule keyed on
 *      `workflow.node_id == <uuid>` fires when the headers arrive
 *      and DOES NOT fire when the same call goes without them.
 *      Guards the "same tool_name, two nodes, two policies" story.
 *
 * Uses OpenAI adapter throughout — the DSL wiring is provider-neutral
 * and lives in the handler, so one adapter is enough.
 */

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
import { DslPolicyService } from '../services/policy-dsl';
import { DslEvaluator } from '../policies/dsl/evaluator';
import { compileValidated } from '../policies/dsl/ast';
import type { PolicyDsl } from '@agentguard/core-schema';

/** Minimal DslPolicyService stand-in — bypasses TenantConfigService and
 *  ConfigBus so the test doesn't need a full org row + settings JSON.
 *  The handler only calls `.evaluate()`, so that's the only method we
 *  need to satisfy the structural type. */
function fakeDslPolicy(dsl: PolicyDsl): DslPolicyService {
  const evaluator = new DslEvaluator(compileValidated(dsl));
  return { evaluate: (_org: string, ctx: any) => evaluator.evaluate(ctx) } as unknown as DslPolicyService;
}

const NODE_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const NODE_B = 'bbbbbbbb-1111-2222-3333-444444444444';

// ── harness ──────────────────────────────────────────────────────────
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
    CREATE TABLE tenant_config (
      org_id TEXT PRIMARY KEY,
      config TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const aegisKey = 'aegis_proxydsl';
  const hash = createHash('sha256').update(aegisKey).digest('hex');
  db.prepare(
    `INSERT INTO org_api_keys (org_id, name, key_prefix, key_hash, scopes) VALUES (?, ?, ?, ?, ?)`,
  ).run('default', 'test', 'aegis_pr', hash, '[]');
  return { db, aegisKey };
}

function makeApp(dsl?: PolicyDsl) {
  const { db, aegisKey } = makeDb();
  const logger = pino({ level: 'silent' });
  const audit = new AuditLogService(db, logger);
  const detectors = new DetectorRegistry({ logger });
  const dslPolicy = dsl ? fakeDslPolicy(dsl) : undefined;

  const handler = new ProxyHandler({
    db, logger, detectors, audit,
    adapters: [new OpenAIChatAdapter()],
    dslPolicy,
  });
  const app = express();
  app.use(express.json());
  app.all('/api/v1/llm-proxy/*', handler.handle);
  return { app, db, aegisKey };
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

/** Upstream returns one tool_call the caller wants us to evaluate. */
function mockOpenAiWithToolCall(toolName: string, args: object = {}) {
  const realFetch = globalThis.fetch.bind(globalThis);
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : String(input);
    if (!u.startsWith('https://api.openai.com')) return realFetch(input, init);
    return new Response(JSON.stringify({
      id: 'chat-1',
      model: 'gpt-4',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: toolName, arguments: JSON.stringify(args) },
          }],
        },
      }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => jest.restoreAllMocks());

// ── DSL block wins ───────────────────────────────────────────────────

describe('Proxy · DSL policy enforcement', () => {
  test('DSL block on pending tool_call → response is mangled', async () => {
    const dsl: PolicyDsl = {
      version: 1,
      rules: [{
        name: 'block-stripe-refund',
        when: { 'tool.name': 'stripe_refund' },
        then: { decision: 'block', reason: 'refunds are irreversible' },
      }],
    };
    const { app, aegisKey } = makeApp(dsl);
    mockOpenAiWithToolCall('stripe_refund', { amount: 1000 });
    const { url, close } = await listen(app);
    try {
      const r = await fetch(`${url}/api/v1/llm-proxy/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aegis-key': aegisKey },
        body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'refund order' }] }),
      });
      expect(r.status).toBe(200);
      expect(r.headers.get('x-aegis-blocked-tool-calls')).toBe('1');
      const body = await r.json() as any;
      // OpenAI adapter replaces the tool_call with a refusal message,
      // so the model sees "tool not available" and can recover.
      const msg = body.choices?.[0]?.message;
      // Either content mentions the block, or tool_calls are cleared —
      // both are valid "mangled" shapes.
      const mangled =
        (msg?.content && String(msg.content).length > 0) ||
        !msg?.tool_calls ||
        msg?.tool_calls.length === 0;
      expect(mangled).toBe(true);
    } finally { close(); }
  });

  test('DSL pending → block in proxy path (cannot hold for approval)', async () => {
    const dsl: PolicyDsl = {
      version: 1,
      rules: [{
        name: 'pending-wire-transfer',
        when: { 'tool.name': 'wire_transfer' },
        then: { decision: 'pending', reason: 'requires treasury approval' },
      }],
    };
    const { app, aegisKey, db } = makeApp(dsl);
    mockOpenAiWithToolCall('wire_transfer', { to: 'acct-x', amount: 50000 });
    const { url, close } = await listen(app);
    try {
      const r = await fetch(`${url}/api/v1/llm-proxy/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aegis-key': aegisKey },
        body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'wire it' }] }),
      });
      expect(r.status).toBe(200);
      expect(r.headers.get('x-aegis-blocked-tool-calls')).toBe('1');

      // Audit row must record the ORIGINAL pending decision so operators
      // can see this was pending-treated-as-block, not an outright block.
      const row = db.prepare(
        `SELECT details FROM admin_audit_log WHERE action = 'proxy.llm_call' ORDER BY id DESC LIMIT 1`,
      ).get() as { details: string };
      const details = JSON.parse(row.details);
      const dslEntry = details.dsl?.[0];
      expect(dslEntry).toBeDefined();
      expect(dslEntry.decision).toBe('pending');    // what the rule actually said
      expect(dslEntry.treated_as).toBe('block');    // what the proxy did with it
      expect(dslEntry.rule_name).toBe('pending-wire-transfer');
    } finally { close(); }
  });

  test('no matching DSL rule → detector-only behavior (allow through)', async () => {
    const dsl: PolicyDsl = {
      version: 1,
      rules: [{
        name: 'block-other-tool',
        when: { 'tool.name': 'delete_prod_db' },
        then: { decision: 'block', reason: 'nope' },
      }],
    };
    const { app, aegisKey } = makeApp(dsl);
    mockOpenAiWithToolCall('list_customers', {});
    const { url, close } = await listen(app);
    try {
      const r = await fetch(`${url}/api/v1/llm-proxy/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aegis-key': aegisKey },
        body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'list' }] }),
      });
      expect(r.status).toBe(200);
      expect(r.headers.get('x-aegis-blocked-tool-calls')).toBeNull();
      const body = await r.json() as any;
      expect(body.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe('list_customers');
    } finally { close(); }
  });
});

// ── Workflow-anchored policy ─────────────────────────────────────────

describe('Proxy · workflow-anchored DSL', () => {
  test('rule keyed on workflow.node_id fires only when header present', async () => {
    // Same tool_name, but only when it's called inside NODE_A does the
    // rule fire. NODE_B calls the same tool freely.
    const dsl: PolicyDsl = {
      version: 1,
      rules: [{
        name: 'send-email-blocked-in-support-node',
        when: {
          all: [
            { 'tool.name':        'send_email' },
            { 'workflow.node_id': NODE_A },
          ],
        },
        then: { decision: 'block', reason: 'support agents cannot send email directly' },
      }],
    };
    const { app, aegisKey } = makeApp(dsl);
    const { url, close } = await listen(app);
    try {
      // Case 1 — with NODE_A header → block fires
      const spy1 = mockOpenAiWithToolCall('send_email');
      const r1 = await fetch(`${url}/api/v1/llm-proxy/openai/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-aegis-key': aegisKey,
          'x-aegis-workflow-node-id': NODE_A,
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });
      expect(r1.status).toBe(200);
      expect(r1.headers.get('x-aegis-blocked-tool-calls')).toBe('1');
      spy1.mockRestore();

      // Case 2 — with NODE_B header → no rule match, tool call passes through
      const spy2 = mockOpenAiWithToolCall('send_email');
      const r2 = await fetch(`${url}/api/v1/llm-proxy/openai/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-aegis-key': aegisKey,
          'x-aegis-workflow-node-id': NODE_B,
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });
      expect(r2.status).toBe(200);
      expect(r2.headers.get('x-aegis-blocked-tool-calls')).toBeNull();
      spy2.mockRestore();

      // Case 3 — no header at all → also no match
      const spy3 = mockOpenAiWithToolCall('send_email');
      const r3 = await fetch(`${url}/api/v1/llm-proxy/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aegis-key': aegisKey },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });
      expect(r3.status).toBe(200);
      expect(r3.headers.get('x-aegis-blocked-tool-calls')).toBeNull();
      spy3.mockRestore();
    } finally { close(); }
  });

  test('malformed workflow header is silently dropped (fail-safe)', async () => {
    // A client bug that sends "not-a-uuid" must not accidentally match
    // some other rule or crash the request. The proxy strips it, DSL
    // sees no workflow context.
    const dsl: PolicyDsl = {
      version: 1,
      rules: [{
        name: 'block-if-any-node',
        when: { 'workflow.node_id': { matches: '.+' } },
        then: { decision: 'block', reason: 'no unclassified traffic' },
      }],
    };
    const { app, aegisKey } = makeApp(dsl);
    mockOpenAiWithToolCall('list_customers');
    const { url, close } = await listen(app);
    try {
      const r = await fetch(`${url}/api/v1/llm-proxy/openai/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-aegis-key': aegisKey,
          'x-aegis-workflow-node-id': 'not-a-uuid',
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });
      expect(r.status).toBe(200);
      // The bad header was dropped, so the rule saw no workflow.node_id
      // and did NOT fire.
      expect(r.headers.get('x-aegis-blocked-tool-calls')).toBeNull();
    } finally { close(); }
  });
});
