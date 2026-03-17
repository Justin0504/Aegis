import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import pino from 'pino';
import { config } from './config';
import { initializeDatabase, getOrCreateDashboardKey } from './db/database';
import { MCPProxyService } from './mcp/proxy-service';
import { AegisMcpServer } from './mcp/aegis-mcp-server';
import { TraceAPI } from './api/traces';
import { PolicyAPI } from './api/policies';
import { ApprovalAPI } from './api/approvals';
import { CheckAPI } from './api/check';
import { AgentsAPI } from './api/agents';
import { PolicyEngine } from './policies/policy-engine';
import { KillSwitchService } from './services/kill-switch';
import { WebhookService } from './services/webhooks';
import { WebhookAPI } from './api/webhooks';
import { ProxyRegistryAPI } from './api/proxy-registry';
import { SlidingWindowStats } from './services/sliding-window';
import { AnomalyDetector } from './services/anomaly-detector';
import { ProfileManager } from './services/profile-manager';
import { errorMiddleware } from './middleware/error';
import { createAuthMiddleware } from './middleware/auth';
import { initOtel, shutdownOtel } from './services/otel';

const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
    },
  },
});

async function main() {
  // Initialize OpenTelemetry (before anything else)
  initOtel();

  // Initialize database
  logger.info('Initializing database...');
  const db = await initializeDatabase(config.database.path);

  // Dashboard API key (auto-generated on first start)
  const dashboardKey = getOrCreateDashboardKey(db);
  logger.info({ key: dashboardKey }, '🔑 Dashboard API key (add to Settings → Gateway API Key)');

  // Initialize services
  const policyEngine  = new PolicyEngine(db, logger);
  const killSwitch    = new KillSwitchService(db, logger);
  const webhooks      = new WebhookService(db, logger);
  const mcpProxy      = new MCPProxyService(db, policyEngine, killSwitch, logger);
  const aegisMcp      = new AegisMcpServer(db, logger);
  const requireAuth   = createAuthMiddleware(db);

  // Anomaly detection engine
  const slidingWindow   = new SlidingWindowStats(
    config.anomaly.slidingWindow.maxAgents,
    config.anomaly.slidingWindow.bufferSize,
  );
  const anomalyDetector = new AnomalyDetector(
    slidingWindow,
    undefined, // default weights (used as fallback)
    config.anomaly.thresholds,
    config.anomaly.isolationForest,
    config.anomaly.ppm,
  );
  const profileManager  = new ProfileManager(db, logger, {
    minTraces: config.anomaly.minTraces,
    graduationTraces: config.anomaly.graduationTraces,
    windowDays: config.anomaly.profileWindowDays,
    rebuildIntervalMs: config.anomaly.profileRebuildIntervalHours * 3600 * 1000,
  });
  await profileManager.initialize();
  logger.info({ profiles: profileManager.size, enabled: config.anomaly.enabled }, 'Anomaly detection engine ready');

  // Create Express app
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // CORS — allow cockpit and other frontends
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Health check (public) — verifies DB connection
  app.get('/health', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok', timestamp: new Date().toISOString(), db: 'connected' });
    } catch (err: any) {
      res.status(503).json({ status: 'unhealthy', timestamp: new Date().toISOString(), db: 'disconnected', error: err.message });
    }
  });

  // Auth bootstrap: return key if no auth header present (first-time setup only)
  app.get('/api/v1/auth/key', (req, res) => {
    const row = db.prepare('SELECT value FROM gateway_config WHERE key = ?').get('dashboard_api_key') as { value: string } | undefined;
    res.json({ api_key: row?.value ?? null });
  });

  // Auth regenerate (requires current key)
  app.post('/api/v1/auth/regenerate', requireAuth, (req, res) => {
    const { randomUUID } = require('crypto');
    const newKey = randomUUID();
    db.prepare('INSERT OR REPLACE INTO gateway_config (key, value) VALUES (?, ?)').run('dashboard_api_key', newKey);
    logger.info({ key: newKey }, '🔑 Dashboard API key regenerated');
    res.json({ api_key: newKey });
  });

  // ── Rate limiter for /api/v1/check (sliding window, per agent_id) ──────────
  const rateLimitWindow = new Map<string, number[]>();
  const RATE_LIMIT_MAX = 100;    // max requests per window
  const RATE_LIMIT_MS  = 60_000; // 1-minute window

  // Cleanup stale entries every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of rateLimitWindow) {
      const active = timestamps.filter(t => now - t < RATE_LIMIT_MS);
      if (active.length === 0) rateLimitWindow.delete(key);
      else rateLimitWindow.set(key, active);
    }
  }, 5 * 60_000);

  app.use('/api/v1/check', (req, res, next) => {
    if (req.method !== 'POST') return next();
    const key = req.body?.agent_id || req.ip || 'unknown';
    const now = Date.now();
    const timestamps = (rateLimitWindow.get(key) || []).filter(t => now - t < RATE_LIMIT_MS);
    if (timestamps.length >= RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Rate limit exceeded', retry_after_ms: RATE_LIMIT_MS });
    }
    timestamps.push(now);
    rateLimitWindow.set(key, timestamps);
    next();
  });

  // SDK ingest routes (public — no auth required)
  app.use('/api/v1/traces', new TraceAPI(db, logger).router);
  app.use('/api/v1/check',  new CheckAPI(
    db, policyEngine, logger, webhooks, undefined,
    config.anomaly.enabled ? anomalyDetector : undefined,
    config.anomaly.enabled ? profileManager : undefined,
    config.anomaly.enabled ? slidingWindow : undefined,
  ).router);

  // Management routes (auth required)
  app.use('/api/v1/policies',  requireAuth, new PolicyAPI(db, policyEngine, logger).router);
  app.use('/api/v1/approvals', requireAuth, new ApprovalAPI(db, logger).router);
  app.use('/api/v1/webhooks',  requireAuth, new WebhookAPI(webhooks).router);
  app.use('/api/v1/agents',    requireAuth, new AgentsAPI(db, logger).router);
  app.use('/api/v1/proxy',     requireAuth, new ProxyRegistryAPI(db, logger).router);

  // Anomaly events endpoint (auth required)
  app.get('/api/v1/anomalies', requireAuth, (req, res) => {
    try {
      const { agent_id, min_score, decision } = req.query as Record<string, string>;
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const offset = Number(req.query.offset ?? 0);

      let sql = 'SELECT * FROM anomaly_events WHERE 1=1';
      const params: any[] = [];

      if (agent_id) { sql += ' AND agent_id = ?'; params.push(agent_id); }
      if (min_score) { sql += ' AND composite_score >= ?'; params.push(parseFloat(min_score)); }
      if (decision) { sql += ' AND decision = ?'; params.push(decision); }

      sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as any[];
      const total = (db.prepare(
        sql.replace(/SELECT \*/, 'SELECT COUNT(*) as n').replace(/ORDER BY.*$/, '')
      ).get(...params.slice(0, -2)) as any).n;

      res.json({
        events: rows.map(r => ({
          ...r,
          signals: JSON.parse(r.signals),
        })),
        total,
        limit,
        offset,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to query anomaly events');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Seed demo data (auth required)
  app.post('/api/v1/seed', requireAuth, (req, res) => {
    try {
      const { randomUUID } = require('crypto');
      const agents = ['research-bot-01', 'data-pipeline-x', 'customer-support-ai', 'code-review-agent'];
      const tools = [
        { name: 'web_search', cat: 'network', args: (i: number) => ({ query: [`latest AI research papers`, `climate change statistics 2026`, `stock market trends`][i % 3] }) },
        { name: 'read_file', cat: 'file', args: (i: number) => ({ path: [`/data/reports/q1.csv`, `/home/user/notes.md`, `/var/log/app.log`][i % 3] }) },
        { name: 'execute_sql', cat: 'database', args: (i: number) => ({ sql: [`SELECT * FROM users WHERE active = 1`, `SELECT COUNT(*) FROM orders`, `SELECT name, email FROM customers LIMIT 10`][i % 3] }) },
        { name: 'send_request', cat: 'network', args: (i: number) => ({ url: `https://api.example.com/v1/data`, method: 'GET' }) },
        { name: 'write_file', cat: 'file', args: (i: number) => ({ path: `/tmp/output_${i}.json`, content: '{}' }) },
      ];
      const models = ['claude-sonnet-4-20250514', 'gpt-4o', 'claude-haiku-4-5-20251001'];
      const statuses = ['AUTO_APPROVED', 'AUTO_APPROVED', 'AUTO_APPROVED', 'APPROVED', 'REJECTED', 'PENDING_APPROVAL'];
      const sessions = [randomUUID(), randomUUID(), randomUUID()];
      const now = Date.now();

      const insertTrace = db.prepare(`
        INSERT OR IGNORE INTO traces (
          trace_id, agent_id, timestamp, sequence_number,
          input_context, thought_chain, tool_call, observation,
          integrity_hash, safety_validation, approval_status,
          environment, version, model, input_tokens, output_tokens, cost_usd,
          session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertViolation = db.prepare(`
        INSERT INTO violations (agent_id, policy_id, trace_id, violation_type, details)
        VALUES (?, ?, ?, ?, ?)
      `);

      let count = 0;
      const txn = db.transaction(() => {
        for (let i = 0; i < 80; i++) {
          const traceId = randomUUID();
          const agent = agents[i % agents.length];
          const tool = tools[i % tools.length];
          const model = models[i % models.length];
          const session = sessions[i % sessions.length];
          const ts = new Date(now - (80 - i) * 3 * 60_000).toISOString();
          const duration = 50 + Math.floor(Math.random() * 500);
          const inputTokens = 200 + Math.floor(Math.random() * 2000);
          const outputTokens = 100 + Math.floor(Math.random() * 1000);
          const cost = (inputTokens * 0.000003 + outputTokens * 0.000015).toFixed(6);

          const isViolation = i % 12 === 0;
          const status = isViolation ? 'REJECTED' : statuses[i % statuses.length];
          const policyIds   = ['sql-injection', 'file-access', 'prompt-injection'];
          const policyNames = ['SQL Injection Prevention', 'File Access Control', 'Prompt Injection Detection'];
          const validation = isViolation
            ? { passed: false, risk_level: i % 24 === 0 ? 'CRITICAL' : 'HIGH', policy_name: policyNames[i % 3], violations: ['Potentially dangerous pattern detected'] }
            : { passed: true, risk_level: 'LOW', policy_name: 'default', violations: [] };

          insertTrace.run(
            traceId, agent, ts, i,
            JSON.stringify({ prompt: `Perform ${tool.name} operation` }),
            JSON.stringify({ raw_tokens: '' }),
            JSON.stringify({ tool_name: tool.name, function: tool.name, arguments: tool.args(i), timestamp: ts }),
            JSON.stringify({ raw_output: { success: true, result: `Completed ${tool.name}` }, duration_ms: duration }),
            randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
            JSON.stringify(validation), status,
            'PRODUCTION', '1.0.0', model, inputTokens, outputTokens, parseFloat(cost),
            session
          );

          if (isViolation) {
            insertViolation.run(agent, policyIds[i % 3], traceId, validation.risk_level, JSON.stringify(validation.violations));
          }
          count++;
        }
      });

      txn();
      logger.info({ count }, 'Demo data seeded');
      res.json({ success: true, traces_created: count });
    } catch (error: any) {
      logger.error({ error }, 'Failed to seed demo data');
      res.status(500).json({ error: error.message });
    }
  });

  // Stats endpoint (auth required)
  app.get('/api/v1/stats', requireAuth, (req, res) => {
    try {
      const totalTraces      = (db.prepare('SELECT COUNT(*) as n FROM traces').get() as any).n;
      const activeAgents     = (db.prepare("SELECT COUNT(DISTINCT agent_id) as n FROM traces WHERE timestamp > datetime('now', '-1 day')").get() as any).n;
      const rejectedCount    = (db.prepare("SELECT COUNT(*) as n FROM traces WHERE approval_status = 'REJECTED'").get() as any).n;

      // Pending checks from blocking mode (real-time human-in-the-loop)
      let pendingChecks = 0;
      try {
        pendingChecks = (db.prepare("SELECT COUNT(*) as n FROM pending_checks WHERE decision = 'pending' AND expires_at > datetime('now')").get() as any).n;
      } catch (e) { logger.debug({ error: e }, 'pending_checks table not ready'); }

      // Critical = traces with CRITICAL risk level
      let criticalCount = 0;
      try {
        criticalCount = (db.prepare("SELECT COUNT(*) as n FROM traces WHERE json_extract(safety_validation, '$.risk_level') IN ('CRITICAL', 'HIGH')").get() as any).n;
      } catch (e) { logger.debug({ error: e }, 'critical count query failed'); }

      // Blocked agents = distinct agents that have been rejected
      const blockedAgents = (db.prepare("SELECT COUNT(DISTINCT agent_id) as n FROM traces WHERE approval_status = 'REJECTED'").get() as any).n;

      let violations24h = 0;
      try {
        violations24h = (db.prepare("SELECT COUNT(*) as n FROM violations WHERE created_at > datetime('now', '-1 day')").get() as any).n;
      } catch (e) { logger.debug({ error: e }, 'violations table not ready'); }

      // Trend calculations: compare last 1h vs previous 1h
      const tracesLastHour = (db.prepare("SELECT COUNT(*) as n FROM traces WHERE timestamp > datetime('now', '-1 hour')").get() as any).n;
      const tracesPrevHour = (db.prepare("SELECT COUNT(*) as n FROM traces WHERE timestamp > datetime('now', '-2 hours') AND timestamp <= datetime('now', '-1 hour')").get() as any).n;
      const tracesTrend = tracesPrevHour > 0 ? Math.round(((tracesLastHour - tracesPrevHour) / tracesPrevHour) * 100) : (tracesLastHour > 0 ? 100 : 0);

      const agentsPrevDay = (db.prepare("SELECT COUNT(DISTINCT agent_id) as n FROM traces WHERE timestamp > datetime('now', '-2 days') AND timestamp <= datetime('now', '-1 day')").get() as any).n;
      const newAgentsToday = Math.max(0, activeAgents - agentsPrevDay);

      let violationsPrevDay = 0;
      try {
        violationsPrevDay = (db.prepare("SELECT COUNT(*) as n FROM violations WHERE created_at > datetime('now', '-2 days') AND created_at <= datetime('now', '-1 day')").get() as any).n;
      } catch (e) { logger.debug({ error: e }, 'violations table not ready'); }
      const violationsTrend = violationsPrevDay > 0 ? Math.round(((violations24h - violationsPrevDay) / violationsPrevDay) * 100) : (violations24h > 0 ? 100 : 0);

      res.json({
        totalTraces, activeAgents, newAgents: newAgentsToday,
        pendingChecks, criticalAlerts: criticalCount,
        violations24h, blockedAgents,
        tracesTrend, violationsTrend,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to get stats');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Error middleware
  app.use(errorMiddleware);

  // Create HTTP server
  const server = createServer(app);

  // MCP proxy (for agent tools)
  const wss = new WebSocketServer({ server, path: '/mcp' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const agentId = url.searchParams.get('agent_id') || req.headers['x-agent-id'] as string || undefined;
    logger.info({ ip: req.socket.remoteAddress, agentId }, 'MCP client connected');
    mcpProxy.handleConnection(ws, agentId);
  });

  // AEGIS MCP server (exposes audit data to Claude Desktop)
  const wssAudit = new WebSocketServer({ server, path: '/mcp-audit' });
  wssAudit.on('connection', (ws) => {
    aegisMcp.handleConnection(ws);
  });

  // Start server
  const port = config.server.port || 8080;
  server.listen(port, () => {
    logger.info({ port }, 'AgentGuard Gateway started');
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    server.close(() => {
      db.close();
      shutdownOtel().finally(() => process.exit(0));
    });
  });
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
