export const config = {
  server: {
    port: parseInt(process.env.PORT || '8080', 10),
    host: process.env.HOST || '0.0.0.0',
  },
  database: {
    path: process.env.DB_PATH || './agentguard.db',
  },
  mcp: {
    defaultTimeout: parseInt(process.env.MCP_TIMEOUT || '30000', 10),
    maxConcurrentRequests: parseInt(process.env.MCP_MAX_CONCURRENT || '100', 10),
  },
  policies: {
    defaultRiskThreshold: process.env.DEFAULT_RISK_THRESHOLD || 'MEDIUM',
    autoApproveBelow: process.env.AUTO_APPROVE_BELOW || 'LOW',
  },
  killSwitch: {
    maxViolations: parseInt(process.env.KILL_SWITCH_MAX_VIOLATIONS || '3', 10),
    violationWindow: parseInt(process.env.KILL_SWITCH_WINDOW || '3600', 10), // seconds
  },
  redis: {
    enabled: process.env.REDIS_ENABLED === 'true',
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
} as const;