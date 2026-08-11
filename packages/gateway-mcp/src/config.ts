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

  // Body parser
  JSON_BODY_LIMIT:   z.string().default('2mb'),

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
  AEGIS_LICENSE_TIER: z.enum(['community', 'pro', 'team', 'enterprise']).default('community'),

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
  bodyParser: {
    jsonLimit: env.JSON_BODY_LIMIT,
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
    tier: env.AEGIS_LICENSE_TIER as LicenseTier,
  },
} as const;

/** Canonical tier ordering. Every enforcement check ranks against this. */
export type LicenseTier = 'community' | 'pro' | 'team' | 'enterprise';
export const TIER_RANK: Record<LicenseTier, number> = {
  community: 0, pro: 1, team: 2, enterprise: 3,
};

/**
 * Max **enforced** agents per license tier. Agents past the cap still
 * get registered — they're just flagged `audit_only` so the gateway
 * traces them without ever blocking. Prevents "we can't ship because
 * you'll block prod" while giving the buyer a concrete upgrade signal.
 *   community  →   3   (solo dev evaluating)
 *   pro        →  20   (small team gating production agents)
 *   team+      → unlimited
 */
export const AGENT_ENFORCEMENT_LIMITS: Record<LicenseTier, number> = {
  community: 3,
  pro:       20,
  team:      Number.POSITIVE_INFINITY,
  enterprise: Number.POSITIVE_INFINITY,
};

export function agentLimitForTier(tier: LicenseTier): number {
  return AGENT_ENFORCEMENT_LIMITS[tier];
}

/**
 * Feature availability by license tier. Order = tier hierarchy from
 * FREE (community) up to ENTERPRISE. When adding a feature: pick the
 * MINIMUM paid tier that unlocks it, then add every tier at that rank
 * or above. `isFeatureEnabled()` checks membership at runtime.
 *
 * Open-core principle: OSS core (traces + basic detectors + policies)
 * is FREE forever at every tier. Advanced detectors, editor UX,
 * enterprise auth, compliance artifacts, and long retention are the
 * paid gates.
 */
export const FEATURE_GATES: Record<string, LicenseTier[]> = {
  // ── Free tier baseline (every install gets these) ─────────────
  'traces':                ['community', 'pro', 'team', 'enterprise'],
  'policies':              ['community', 'pro', 'team', 'enterprise'],
  'blocking':              ['community', 'pro', 'team', 'enterprise'],
  'basic-anomaly':         ['community', 'pro', 'team', 'enterprise'],
  'community-packs':       ['community', 'pro', 'team', 'enterprise'],

  // ── Pro tier ($49/mo) — production-ready detectors + editor ──
  'judge':                 ['pro', 'team', 'enterprise'],
  'anomaly':               ['pro', 'team', 'enterprise'],
  'dsl-editor':            ['pro', 'team', 'enterprise'],
  'ai-policy-generator':   ['pro', 'team', 'enterprise'],
  'multi-agent-collusion': ['pro', 'team', 'enterprise'],
  'oidc-sso':              ['pro', 'team', 'enterprise'],
  'supply-chain':          ['pro', 'team', 'enterprise'],
  'webhook-retry':         ['pro', 'team', 'enterprise'],

  // ── Team tier ($199/mo) — compliance-grade audit + enterprise auth
  'crypto-audit':          ['team', 'enterprise'],
  'witness-cosignature':   ['team', 'enterprise'],
  'saml-sso':              ['team', 'enterprise'],
  'scim-provisioning':     ['team', 'enterprise'],
  'pi-corpus':             ['team', 'enterprise'],
  'coverage-report':       ['team', 'enterprise'],
  'policy-effectiveness':  ['team', 'enterprise'],
  'multi-tenancy':         ['team', 'enterprise'],
  'rbac':                  ['team', 'enterprise'],

  // ── Business tier ($599/mo) — EE self-host + long retention ──
  'ee-self-host':          ['team', 'enterprise'],
  'custom-detectors':      ['team', 'enterprise'],
  'long-retention':        ['team', 'enterprise'],
  'delegation-observability':['team', 'enterprise'],
  'managed-self-host':     ['team', 'enterprise'],
  'data-retention':        ['team', 'enterprise'],

  // ── Enterprise only — compliance artifacts + hard SLA ────────
  'soc2-evidence':         ['enterprise'],
  'byoc':                  ['enterprise'],
  'onprem-airgap':         ['enterprise'],
  'sla-99-9':              ['enterprise'],
  'sla-metrics':           ['enterprise'],
  'audit-log':             ['enterprise'],
  'usage-metering':        ['enterprise'],
  'dedicated-slack':       ['enterprise'],
};

export function isFeatureEnabled(feature: string): boolean {
  const tiers = FEATURE_GATES[feature];
  if (!tiers) return true; // unknown feature = allowed
  return tiers.includes(config.license.tier);
}

/** Check whether the current tier is at or above a given minimum tier. */
export function hasMinTier(min: LicenseTier): boolean {
  return TIER_RANK[config.license.tier] >= TIER_RANK[min];
}
