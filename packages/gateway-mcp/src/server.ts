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

  // SDK ingest routes (public — no auth required)
  app.use('/api/v1/traces', new TraceAPI(db, logger).router);
  app.use('/api/v1/check',  new CheckAPI(db, policyEngine, logger, webhooks).router);

  // Management routes (auth required)
  app.use('/api/v1/policies',  requireAuth, new PolicyAPI(db, policyEngine, logger).router);
  app.use('/api/v1/approvals', requireAuth, new ApprovalAPI(db, logger).router);
  app.use('/api/v1/webhooks',  requireAuth, new WebhookAPI(webhooks).router);
  app.use('/api/v1/agents',    requireAuth, new AgentsAPI(db, logger).router);

  // Stats endpoint (auth required)
  app.get('/api/v1/stats', requireAuth, (req, res) => {
    try {
      const totalTraces      = (db.prepare('SELECT COUNT(*) as n FROM traces').get() as any).n;
      const activeAgents     = (db.prepare("SELECT COUNT(DISTINCT agent_id) as n FROM traces WHERE timestamp > datetime('now', '-1 day')").get() as any).n;
      const pendingApprovals = (db.prepare("SELECT COUNT(*) as n FROM traces WHERE approval_status IS NULL").get() as any).n;
      const rejectedCount    = (db.prepare("SELECT COUNT(*) as n FROM traces WHERE approval_status = 'REJECTED'").get() as any).n;
      let violations24h = 0;
      try {
        violations24h = (db.prepare("SELECT COUNT(*) as n FROM violations WHERE created_at > datetime('now', '-1 day')").get() as any).n;
      } catch {}
      res.json({ totalTraces, activeAgents, newAgents: activeAgents, pendingApprovals, criticalApprovals: rejectedCount, violations24h, blockedAgents: rejectedCount });
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
