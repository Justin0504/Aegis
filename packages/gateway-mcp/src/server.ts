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