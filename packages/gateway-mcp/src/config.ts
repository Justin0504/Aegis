import { z } from 'zod';

// ── Environment validation schema ──────────────────────────────────────────
const envSchema = z.object({
  // Server
  PORT:       z.coerce.number().int().min(1).max(65535).default(8080),
  HOST:       z.string().default('0.0.0.0'),
  NODE_ENV:   z.enum(['development', 'production', 'test']).default('development'),

  // CORS
  ALLOWED_ORIGINS: z.string().optional(), // comma-separated, empty = allow all in dev

  // Database
  DB_PATH:    z.string().default('./agentguard.db'),

  // MCP
  MCP_TIMEOUT:        z.coerce.number().int().min(1000).default(30000),
  MCP_MAX_CONCURRENT: z.coerce.number().int().min(1).default(100),

  // Policies
  DEFAULT_RISK_THRESHOLD: z.string().default('MEDIUM'),
  AUTO_APPROVE_BELOW:     z.string().default('LOW'),

  // Kill switch
  KILL_SWITCH_MAX_VIOLATIONS: z.coerce.number().int().min(1).default(3),
  KILL_SWITCH_WINDOW:         z.coerce.number().int().min(60).default(3600),

  // Rate limiting
  RATE_LIMIT_MAX:    z.coerce.number().int().min(1).default(100),
  RATE_LIMIT_WINDOW: z.coerce.number().int().min(1000).default(60000),

  // Anomaly
  ANOMALY_ENABLED:          z.string().default('true'),
  ANOMALY_MIN_TRACES:       z.coerce.number().int().min(1).default(50),
  ANOMALY_GRADUATION_TRACES:z.coerce.number().int().min(1).default(200),
  ANOMALY_REBUILD_HOURS:    z.coerce.number().int().min(1).default(24),
  ANOMALY_WINDOW_DAYS:      z.coerce.number().int().min(1).default(14),
  ANOMALY_THRESHOLD_FLAG:     z.coerce.number().min(0).max(1).default(0.3),
  ANOMALY_THRESHOLD_ESCALATE: z.coerce.number().min(0).max(1).default(0.6),
  ANOMALY_THRESHOLD_BLOCK:    z.coerce.number().min(0).max(1).default(0.85),
  ANOMALY_MAX_AGENTS:         z.coerce.number().int().min(1).default(10000),
  ANOMALY_BUFFER_SIZE:        z.coerce.number().int().min(10).default(300),
  ANOMALY_IF_TREES:           z.coerce.number().int().min(1).default(100),
  ANOMALY_IF_SAMPLE_SIZE:     z.coerce.number().int().min(1).default(256),
  ANOMALY_IF_MIN_SAMPLES:     z.coerce.number().int().min(1).default(30),
  ANOMALY_EWMA_ALPHA:         z.coerce.number().min(0).max(1).default(0.05),
  ANOMALY_EWMA_PERSIST_N:     z.coerce.number().int().min(1).default(10),
  ANOMALY_EWMA_PERSIST_MS:    z.coerce.number().int().min(1000).default(60000),
  ANOMALY_PPM_ORDER:           z.coerce.number().int().min(1).default(4),
  ANOMALY_PPM_SURPRISE_SCALE:  z.coerce.number().min(0).default(3.0),

  // Redis
  REDIS_ENABLED: z.string().default('false'),
  REDIS_URL:     z.string().default('redis://localhost:6379'),

  // OpenTelemetry
  OTEL_ENABLED:                   z.string().default('false'),
  OTEL_EXPORTER_OTLP_ENDPOINT:    z.string().default('http://localhost:4318'),
  OTEL_SERVICE_NAME:              z.string().default('aegis-gateway'),

  // Webhook retry
  WEBHOOK_MAX_RETRIES:  z.coerce.number().int().min(0).default(3),
  WEBHOOK_RETRY_BASE_MS:z.coerce.number().int().min(100).default(1000),
  WEBHOOK_TIMEOUT_MS:   z.coerce.number().int().min(1000).default(10000),

  // License / feature gating
  AEGIS_LICENSE_TIER: z.enum(['community', 'pro', 'enterprise']).default('community'),

  // Graceful shutdown
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
});

// Parse and validate — fail fast on bad config
function loadEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment configuration:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

const env = loadEnv();

export const config = {
  server: {
    port: env.PORT,
    host: env.HOST,
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  },
  cors: {
    allowedOrigins: env.ALLOWED_ORIGINS
      ? env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
      : null, // null = reflect origin in dev, strict in production
  },
  database: {
    path: env.DB_PATH,
  },
  mcp: {
    defaultTimeout: env.MCP_TIMEOUT,
    maxConcurrentRequests: env.MCP_MAX_CONCURRENT,
  },
  policies: {
    defaultRiskThreshold: env.DEFAULT_RISK_THRESHOLD,
    autoApproveBelow: env.AUTO_APPROVE_BELOW,
  },
  killSwitch: {
    maxViolations: env.KILL_SWITCH_MAX_VIOLATIONS,
    violationWindow: env.KILL_SWITCH_WINDOW,
  },
  rateLimit: {
    max: env.RATE_LIMIT_MAX,
    windowMs: env.RATE_LIMIT_WINDOW,
  },
  anomaly: {
    enabled: env.ANOMALY_ENABLED !== 'false',
    minTraces: env.ANOMALY_MIN_TRACES,
    graduationTraces: env.ANOMALY_GRADUATION_TRACES,
    profileRebuildIntervalHours: env.ANOMALY_REBUILD_HOURS,
    profileWindowDays: env.ANOMALY_WINDOW_DAYS,
    thresholds: {
      flag: env.ANOMALY_THRESHOLD_FLAG,
      escalate: env.ANOMALY_THRESHOLD_ESCALATE,
      block: env.ANOMALY_THRESHOLD_BLOCK,
    },
    slidingWindow: {
      maxAgents: env.ANOMALY_MAX_AGENTS,
      bufferSize: env.ANOMALY_BUFFER_SIZE,
    },
    isolationForest: {
      numTrees: env.ANOMALY_IF_TREES,
      sampleSize: env.ANOMALY_IF_SAMPLE_SIZE,
      minSamples: env.ANOMALY_IF_MIN_SAMPLES,
    },
    ewma: {
      alpha: env.ANOMALY_EWMA_ALPHA,
      persistEveryN: env.ANOMALY_EWMA_PERSIST_N,
      persistIntervalMs: env.ANOMALY_EWMA_PERSIST_MS,
    },
    ppm: {
      maxOrder: env.ANOMALY_PPM_ORDER,
      surpriseScale: env.ANOMALY_PPM_SURPRISE_SCALE,
    },
  },
  redis: {
    enabled: env.REDIS_ENABLED === 'true',
    url: env.REDIS_URL,
  },
  otel: {
    enabled: env.OTEL_ENABLED === 'true',
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: env.OTEL_SERVICE_NAME,
  },
  webhook: {
    maxRetries: env.WEBHOOK_MAX_RETRIES,
    retryBaseMs: env.WEBHOOK_RETRY_BASE_MS,
    timeoutMs: env.WEBHOOK_TIMEOUT_MS,
  },
  license: {
    tier: env.AEGIS_LICENSE_TIER as 'community' | 'pro' | 'enterprise',
  },
} as const;

/** Feature availability by license tier */
export const FEATURE_GATES: Record<string, ('community' | 'pro' | 'enterprise')[]> = {
  'traces':           ['community', 'pro', 'enterprise'],
  'policies':         ['community', 'pro', 'enterprise'],
  'blocking':         ['community', 'pro', 'enterprise'],
  'anomaly':          ['pro', 'enterprise'],
  'judge':            ['pro', 'enterprise'],
  'multi-tenancy':    ['enterprise'],
  'rbac':             ['enterprise'],
  'audit-log':        ['enterprise'],
  'sla-metrics':      ['enterprise'],
  'data-retention':   ['enterprise'],
  'usage-metering':   ['enterprise'],
  'supply-chain':     ['pro', 'enterprise'],
  'webhook-retry':    ['pro', 'enterprise'],
};

export function isFeatureEnabled(feature: string): boolean {
  const tiers = FEATURE_GATES[feature];
  if (!tiers) return true; // unknown feature = allowed
  return tiers.includes(config.license.tier);
}
