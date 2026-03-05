import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import pino from 'pino';
import { config } from './config';
import { initializeDatabase } from './db/database';
import { MCPProxyService } from './mcp/proxy-service';
import { TraceAPI } from './api/traces';
import { PolicyAPI } from './api/policies';
import { ApprovalAPI } from './api/approvals';
import { PolicyEngine } from './policies/policy-engine';
import { KillSwitchService } from './services/kill-switch';
import { errorMiddleware } from './middleware/error';

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
  // Initialize database
  logger.info('Initializing database...');
  const db = await initializeDatabase(config.database.path);

  // Initialize services
  const policyEngine = new PolicyEngine(db, logger);
  const killSwitch = new KillSwitchService(db, logger);
  const mcpProxy = new MCPProxyService(db, policyEngine, killSwitch, logger);

  // Create Express app
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // API routes
  app.use('/api/v1/traces', new TraceAPI(db, logger).router);
  app.use('/api/v1/policies', new PolicyAPI(db, policyEngine, logger).router);
  app.use('/api/v1/approvals', new ApprovalAPI(db, logger).router);

  // Stats endpoint
  app.get('/api/v1/stats', (req, res) => {
    try {
      const totalTraces = (db.prepare('SELECT COUNT(*) as n FROM traces').get() as any).n;
      const activeAgents = (db.prepare("SELECT COUNT(DISTINCT agent_id) as n FROM traces WHERE created_at > datetime('now', '-1 day')").get() as any).n;
      const pendingApprovals = (db.prepare("SELECT COUNT(*) as n FROM approvals WHERE status = 'PENDING'").get() as any).n;
      const violations24h = (db.prepare("SELECT COUNT(*) as n FROM violations WHERE created_at > datetime('now', '-1 day')").get() as any).n;
      res.json({ totalTraces, activeAgents, newAgents: activeAgents, pendingApprovals, criticalApprovals: 0, violations24h, blockedAgents: 0 });
    } catch (error) {
      logger.error({ error }, 'Failed to get stats');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Error middleware
  app.use(errorMiddleware);

  // Create HTTP server
  const server = createServer(app);

  // Create WebSocket server for MCP
  const wss = new WebSocketServer({ server, path: '/mcp' });

  wss.on('connection', (ws, req) => {
    logger.info({ ip: req.socket.remoteAddress }, 'MCP client connected');
    mcpProxy.handleConnection(ws);
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
      process.exit(0);
    });
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});