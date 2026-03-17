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
  anomaly: {
    enabled: process.env.ANOMALY_ENABLED !== 'false', // on by default
    minTraces: parseInt(process.env.ANOMALY_MIN_TRACES || '50', 10),
    graduationTraces: parseInt(process.env.ANOMALY_GRADUATION_TRACES || '200', 10),
    profileRebuildIntervalHours: parseInt(process.env.ANOMALY_REBUILD_HOURS || '24', 10),
    profileWindowDays: parseInt(process.env.ANOMALY_WINDOW_DAYS || '14', 10),
    thresholds: {
      flag: parseFloat(process.env.ANOMALY_THRESHOLD_FLAG || '0.3'),
      escalate: parseFloat(process.env.ANOMALY_THRESHOLD_ESCALATE || '0.6'),
      block: parseFloat(process.env.ANOMALY_THRESHOLD_BLOCK || '0.85'),
    },
    slidingWindow: {
      maxAgents: parseInt(process.env.ANOMALY_MAX_AGENTS || '10000', 10),
      bufferSize: parseInt(process.env.ANOMALY_BUFFER_SIZE || '300', 10),
    },
    isolationForest: {
      numTrees: parseInt(process.env.ANOMALY_IF_TREES || '100', 10),
      sampleSize: parseInt(process.env.ANOMALY_IF_SAMPLE_SIZE || '256', 10),
      minSamples: parseInt(process.env.ANOMALY_IF_MIN_SAMPLES || '30', 10),
    },
    ewma: {
      alpha: parseFloat(process.env.ANOMALY_EWMA_ALPHA || '0.05'),
      persistEveryN: parseInt(process.env.ANOMALY_EWMA_PERSIST_N || '10', 10),
      persistIntervalMs: parseInt(process.env.ANOMALY_EWMA_PERSIST_MS || '60000', 10),
    },
    ppm: {
      maxOrder: parseInt(process.env.ANOMALY_PPM_ORDER || '4', 10),
      surpriseScale: parseFloat(process.env.ANOMALY_PPM_SURPRISE_SCALE || '3.0'),
    },
  },
  redis: {
    enabled: process.env.REDIS_ENABLED === 'true',
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  otel: {
    enabled: process.env.OTEL_ENABLED === 'true',
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318',
    serviceName: process.env.OTEL_SERVICE_NAME || 'aegis-gateway',
  },
} as const;