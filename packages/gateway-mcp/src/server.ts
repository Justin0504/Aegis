import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import pino from 'pino';
import { config, isFeatureEnabled } from './config';
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
import { createErrorMiddleware, HttpError } from './middleware/error';
import { createAuthMiddleware } from './middleware/auth';
import { requestContextMiddleware } from './middleware/request-context';
import { initOtel, shutdownOtel } from './services/otel';
import { LLMJudgeService } from './services/llm-judge';
import { initializeEnterpriseSchema } from './db/enterprise-schema';
import { AuditLogService } from './services/audit-log';
import { RBACService } from './services/rbac';
import { RetentionService } from './services/retention';
import { UsageMeteringService } from './services/usage-metering';
import { SLAMetricsService } from './services/sla-metrics';
import { AdminAPI } from './api/admin';
import { ConfigBus } from './services/config-bus';
import { TenantConfigService } from './services/tenant-config';
import { TenantConfigAPI } from './api/tenant-config';
import { DslPolicyService } from './services/policy-dsl';
import { PolicyDslAPI } from './api/policy-dsl';
import { AlignmentAPI } from './api/alignment';
import { CodeShieldAPI } from './api/code-shield';
import { IntegrityAPI } from './api/integrity';
import { EvidencePackAPI } from './api/evidence-pack';
import { AuthAPI } from './api/auth';
import { SessionService } from './services/session';
import { MockIdpAdapter } from './services/idp-adapter';
import {
  DetectorRegistry,
  PiiDetector,
  ClassifierDetector,
  AnomalyDetectorPlugin,
  BudgetDetector,
  ToolScopeDetector,
  DiscoveryDetector,
  ExfilDetector,
  LateralMovementDetector,
  CrossAgentDetector,
  MemoryPoisonDetector,
  AttackPatternDetector,
} from './detectors';
import { CrossAgentCorrelatorService } from './services/cross-agent-correlator';
import { BudgetGuardService } from './services/budget-guard';
import { CoverageMapService } from './services/coverage-map';
import { OntologyAPI } from './api/ontology';
import { ComplianceBundleService } from './services/compliance-bundle';
import { ComplianceAPI } from './api/compliance';
import { SinkOrchestrator } from './services/sink-orchestrator';
import { SinksAPI } from './api/sinks';
import { BudgetAPI } from './api/budget';
import { OtlpExporterService } from './services/otlp-exporter';
import { ObservabilityAPI } from './api/observability';
import { AgentRegistryService } from './services/agent-registry';
import { TransparencyLogService } from './services/transparency-log';
import { TransparencyLogAPI } from './api/transparency-log';
import { SigningService } from './services/signing';
import {
  ProxyHandler,
  OpenAIChatAdapter,
  AnthropicMessagesAdapter,
} from './proxy';

const VERSION = '2.0.0';

// ── Logger ─────────────────────────────────────────────────────────────────
// All logs go to stderr (fd 2). Critical when this process is launched as
// an MCP stdio server (or piped through mcp2cli) — stdout must carry pure
// JSON-RPC for the protocol to parse. Reported by githb-ac in #4.
const logDest = pino.destination(2);
const logger = config.server.isProduction
  ? pino({ level: process.env.LOG_LEVEL || 'info' }, logDest)
  : pino(
      {
        transport: {
          target: 'pino-pretty',
          options: {
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
            destination: 2,  // pino-pretty's own stderr knob
          },
        },
      },
    );

async function main() {
  const startTime = Date.now();

  // Initialize OpenTelemetry (before anything else)
  initOtel();

  // Initialize database
  logger.info('Initializing database...');
  const db = await initializeDatabase(config.database.path);

  // Enterprise schema (multi-tenancy, RBAC, audit log, retention, usage, SLA)
  initializeEnterpriseSchema(db);

  // Dashboard API key (auto-generated on first start)
  const dashboardKey = getOrCreateDashboardKey(db);
  if (!config.server.isProduction) {
    logger.info({ key: dashboardKey }, 'Dashboard API key (add to Settings)');
  }

  // Initialize services
  const policyEngine  = new PolicyEngine(db, logger);
  const killSwitch    = new KillSwitchService(db, logger);
  const webhooks      = new WebhookService(db, logger);
  const aegisMcp      = new AegisMcpServer(db, logger);
  const requireAuth   = createAuthMiddleware(db);

  // Anomaly detection engine
  const slidingWindow   = new SlidingWindowStats(
    config.anomaly.slidingWindow.maxAgents,
    config.anomaly.slidingWindow.bufferSize,
  );
  const anomalyDetector = new AnomalyDetector(
    slidingWindow,
    undefined,
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

  // Enterprise services
  const auditLog      = new AuditLogService(db, logger);
  const rbac          = new RBACService(db, logger);
  const retention     = new RetentionService(db, logger);
  const usageMetering = new UsageMeteringService(db, logger);
  const slaMetrics    = new SLAMetricsService(db, logger);

  // Per-tenant runtime config (deployment mode, layer toggles, thresholds)
  const configBus     = new ConfigBus(logger);
  const tenantConfig  = new TenantConfigService(db, logger, configBus, auditLog);
  tenantConfig.seedDefaults();

  // Per-tenant policy DSL (fail-safe composer over classifier + AJV + anomaly)
  const dslPolicy = new DslPolicyService(logger, configBus, tenantConfig);
  const orgIds = db.prepare('SELECT id FROM organizations').all() as { id: string }[];
  dslPolicy.warmCache(orgIds.map((o) => o.id));

  // Detector registry — unified Signal contract over PII / classifier /
  // anomaly + future tenant-supplied plugins. Built in parallel with the
  // existing check.ts decision path; consumers can opt in incrementally.
  const detectors = new DetectorRegistry({ logger });
  detectors.register(new ClassifierDetector());
  detectors.register(new PiiDetector());
  if (config.anomaly.enabled) {
    detectors.register(new AnomalyDetectorPlugin(anomalyDetector, profileManager));
  }
  const agentRegistry = new AgentRegistryService(db, logger);
  const budgetGuard = new BudgetGuardService(db, tenantConfig, logger, agentRegistry);
  detectors.register(new BudgetDetector(budgetGuard));
  detectors.register(new ToolScopeDetector(agentRegistry));
  detectors.register(new DiscoveryDetector());
  detectors.register(new ExfilDetector());
  detectors.register(new LateralMovementDetector());
  detectors.register(new MemoryPoisonDetector());
  if (config.attackPattern.enabled) {
    detectors.register(new AttackPatternDetector({
      blockThreshold: config.attackPattern.blockThreshold,
      flagThreshold: config.attackPattern.flagThreshold,
      windowMs: config.attackPattern.windowMs,
      slidingWindow,
    }));
  }
  const crossAgent = new CrossAgentCorrelatorService({ logger });
  detectors.register(new CrossAgentDetector(crossAgent));
  const coverageMap = new CoverageMapService(detectors);

  // Universal sink fan-out. Subscribes to audit log + ConfigBus; every
  // audit row routes to whatever http/syslog/stdout sinks the tenant has
  // declared in tenant_config.sinks. Customer SIEM integration becomes
  // a config write, not a code release.
  const sinkOrchestrator = new SinkOrchestrator(logger, auditLog, tenantConfig, configBus);
  sinkOrchestrator.start(orgIds.map((o) => o.id));

  // OTLP trace exporter — per-tenant polling job that ships trace rows
  // out as OpenTelemetry spans to whatever otlp/v1/traces endpoint the
  // customer pointed AEGIS at (Datadog, Honeycomb, Grafana Tempo,
  // New Relic, OTel collector — all accept the same JSON shape).
  const otlpExporter = new OtlpExporterService(db, logger, tenantConfig, configBus);
  otlpExporter.start(orgIds.map((o) => o.id));

  // Transparency log — RFC 6962 Merkle tree over audit + evidence-pack
  // events, signed with the gateway's existing Ed25519 evidence key.
  // Every audit row also appends here so customers can verify inclusion
  // offline without trusting us to replay our own log.
  const transparencyLog = new TransparencyLogService(db, new SigningService(db, logger), logger);
  auditLog.subscribe(entry => {
    try {
      transparencyLog.append({
        payload: {
          action: entry.action,
          resource_type: entry.resource_type,
          resource_id: entry.resource_id,
          user_email: entry.user_email,
          user_id: entry.user_id,
          ip_address: entry.ip_address,
          details: entry.details,
          timestamp: entry.timestamp,
        },
        source: 'audit',
        org_id: entry.org_id,
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'transparency log append failed');
    }
  });

  // MCP proxy (instantiated after dslPolicy + tenantConfig so DSL flows through)
  const mcpProxy = new MCPProxyService(db, policyEngine, killSwitch, logger, dslPolicy, tenantConfig);

  // Start background schedulers
  if (isFeatureEnabled('data-retention')) {
    retention.start(3600_000);
  }
  if (isFeatureEnabled('sla-metrics')) {
    slaMetrics.start(60_000);
  }

  // ── Express app ──────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json({ limit: config.bodyParser.jsonLimit }));

  // Request ID + access logging (before everything else)
  app.use(requestContextMiddleware(logger));

  // CORS — production-safe origin handling
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = config.cors.allowedOrigins;

    if (allowed && allowed.length > 0) {
      // Strict: only allow configured origins
      if (origin && allowed.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
    } else if (!config.server.isProduction) {
      // Dev mode: reflect origin for convenience
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    } else {
      // Production without config: no wildcard, require ALLOWED_ORIGINS
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Request-ID');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-ID, X-RateLimit-Remaining, X-RateLimit-Reset');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Security headers (OWASP A05:2021 — Security Misconfiguration)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'",
    );
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    next();
  });

  // ── Health / readiness probes ────────────────────────────────────────────
  // Both `/health` (the conventional probe path that Docker/K8s hit) and
  // `/api/v1/health` (the SaaS-style versioned path that Cockpit's Next.js
  // proxy and most SDK pollers expect) are wired to the same handler.
  // Reported by githb-ac in #4.
  const healthHandler = (req: any, res: any) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({
        status: 'ok',
        version: VERSION,
        uptime_s: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(503).json({
        status: 'unhealthy',
        version: VERSION,
        timestamp: new Date().toISOString(),
        error: 'database_unavailable',
      });
    }
  };
  app.get('/health', healthHandler);
  app.get('/api/v1/health', healthHandler);

  app.get('/ready', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      // Check that critical tables exist
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='traces'").get();
      res.json({ ready: true });
    } catch {
      res.status(503).json({ ready: false });
    }
  });

  // Auth bootstrap: return key (no auth required — should be network-restricted in prod)
  app.get('/api/v1/auth/key', (req, res) => {
    if (config.server.isProduction) {
      logger.warn({ ip: req.ip, req_id: req.requestId }, 'Auth bootstrap endpoint accessed in production');
    }
    const row = db.prepare('SELECT value FROM gateway_config WHERE key = ?').get('dashboard_api_key') as { value: string } | undefined;
    res.json({ api_key: row?.value ?? null });
  });

  // Auth regenerate (requires current key)
  app.post('/api/v1/auth/regenerate', requireAuth, (req, res) => {
    const { randomUUID } = require('crypto');
    const newKey = randomUUID();
    db.prepare('INSERT OR REPLACE INTO gateway_config (key, value) VALUES (?, ?)').run('dashboard_api_key', newKey);
    auditLog.log({
      org_id: req.orgId, action: 'apikey.regenerate', resource_type: 'apikey',
      details: { regenerated: true }, ip_address: req.ip,
    });
    logger.info('Dashboard API key regenerated');
    res.json({ api_key: newKey });
  });

  // ── Rate limiter (sliding window, per agent_id) ──────────────────────────
  const rateLimitWindow = new Map<string, number[]>();
  const RATE_LIMIT_MAX = config.rateLimit.max;
  const RATE_LIMIT_MS  = config.rateLimit.windowMs;

  // Cleanup stale entries every 5 minutes
  const rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of rateLimitWindow) {
      const active = timestamps.filter(t => now - t < RATE_LIMIT_MS);
      if (active.length === 0) rateLimitWindow.delete(key);
      else rateLimitWindow.set(key, active);
    }
  }, 5 * 60_000);

  app.use('/api/v1/check', (req, res, next) => {
    if (req.method !== 'POST') return next();
    // Composite key isolates tenants — one noisy tenant cannot exhaust
    // counters for another. /check is unauthenticated, so req.orgId may be
    // undefined; default to a sentinel so it slots into the same key space.
    const orgKey = (req as any).orgId || 'public';
    const agentKey = req.body?.agent_id || req.ip || 'unknown';
    const key = `${orgKey}:${agentKey}`;
    const now = Date.now();
    const timestamps = (rateLimitWindow.get(key) || []).filter(t => now - t < RATE_LIMIT_MS);
    const remaining = RATE_LIMIT_MAX - timestamps.length;

    // Rate limit headers
    res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, remaining - 1));
    res.setHeader('X-RateLimit-Reset', new Date(now + RATE_LIMIT_MS).toISOString());

    if (remaining <= 0) {
      return res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded', retry_after_ms: RATE_LIMIT_MS },
      });
    }
    timestamps.push(now);
    rateLimitWindow.set(key, timestamps);
    next();
  });

  // SLA latency tracking middleware (all /api routes)
  if (isFeatureEnabled('sla-metrics')) {
    app.use('/api', (req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const latency = Date.now() - start;
        const endpoint = req.route?.path ?? req.path.replace(/\/[a-f0-9-]{20,}/, '/:id');
        slaMetrics.record(endpoint, latency, res.statusCode < 500, req.orgId ?? 'default');
      });
      next();
    });
  }

  // Usage metering middleware (track API calls per org)
  if (isFeatureEnabled('usage-metering')) {
    app.use('/api', (req, res, next) => {
      res.on('finish', () => {
        const orgId = req.orgId ?? 'default';
        usageMetering.increment(orgId, 'api_calls', 1);
        if (req.path.includes('/traces') && req.method === 'POST') {
          usageMetering.increment(orgId, 'traces_per_month', 1);
        }
        if (req.path.includes('/judge') && req.method === 'POST') {
          usageMetering.increment(orgId, 'judge_evals_per_month', 1);
        }
      });
      next();
    });
  }

  // ── Feature gate middleware ────────────────────────────────────────────────
  function requireFeature(feature: string) {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (!isFeatureEnabled(feature)) {
        return res.status(403).json({
          error: {
            code: 'FEATURE_UNAVAILABLE',
            message: `Feature '${feature}' requires ${FEATURE_GATES_MSG[feature] || 'a higher'} license tier`,
            current_tier: config.license.tier,
          },
        });
      }
      next();
    };
  }

  const FEATURE_GATES_MSG: Record<string, string> = {
    'anomaly': 'Pro or Enterprise',
    'judge': 'Pro or Enterprise',
    'multi-tenancy': 'Enterprise',
    'rbac': 'Enterprise',
    'audit-log': 'Enterprise',
    'sla-metrics': 'Enterprise',
    'data-retention': 'Enterprise',
    'usage-metering': 'Enterprise',
    'supply-chain': 'Pro or Enterprise',
  };

  // ── SDK ingest routes (public — no auth required) ────────────────────────
  app.use('/api/v1/traces', new TraceAPI(db, logger).router);
  app.use('/api/v1/check',  new CheckAPI(
    db, policyEngine, logger, webhooks, undefined,
    config.anomaly.enabled ? anomalyDetector : undefined,
    config.anomaly.enabled ? profileManager : undefined,
    config.anomaly.enabled ? slidingWindow : undefined,
    dslPolicy,
    tenantConfig,
    detectors,
  ).router);

  // ── Management routes (auth required) ────────────────────────────────────
  app.use('/api/v1/policies',  requireAuth, new PolicyAPI(db, policyEngine, logger).router);
  app.use('/api/v1/approvals', requireAuth, new ApprovalAPI(db, logger).router);
  app.use('/api/v1/webhooks',  requireAuth, new WebhookAPI(webhooks).router);
  app.use('/api/v1/agents',    requireAuth, new AgentsAPI(db, logger, agentRegistry, auditLog).router);
  app.use('/api/v1/proxy',     requireAuth, new ProxyRegistryAPI(db, logger).router);

  // Enterprise admin routes (auth + feature gate)
  app.use('/api/v1/admin', requireAuth, requireFeature('multi-tenancy'),
    new AdminAPI(db, logger, rbac, auditLog, retention, usageMetering, slaMetrics).router);

  // Per-tenant config (self-service, scoped to req.orgId)
  app.use('/api/v1/config', requireAuth, new TenantConfigAPI(tenantConfig, logger).router);

  // Per-tenant DSL (self-service)
  app.use('/api/v1/dsl', requireAuth, new PolicyDslAPI(tenantConfig, dslPolicy, logger).router);

  // AEGIS Agent Threat Ontology + per-deployment coverage map.
  // Customers use /coverage to answer "what does AEGIS detect today?"
  // without taking a sales call. Tenant detectors register against the
  // same registry and automatically extend the published coverage.
  app.use('/api/v1/ontology', requireAuth, new OntologyAPI(coverageMap).router);

  // Universal sink runtime view + dry-fire. Sink CONFIG lives in
  // /api/v1/config (whole tenant config). This endpoint exposes runtime
  // metrics (sent / failed / DLQ depth / last error) per configured sink.
  app.use('/api/v1/sinks', requireAuth, new SinksAPI(sinkOrchestrator, tenantConfig, logger).router);

  // Budget guard read-only status. Config goes through tenant-config PATCH.
  app.use('/api/v1/budget', requireAuth, new BudgetAPI(budgetGuard).router);

  // OTLP exporter status + manual flush. Config (endpoint, headers,
  // interval) lives in /api/v1/config under observability.otlp.
  app.use('/api/v1/observability', requireAuth, new ObservabilityAPI(otlpExporter).router);

  // Transparency log — append-only Merkle tree of audit + evidence-pack
  // events. Customers verify inclusion offline against the signed root.
  app.use('/api/v1/transparency-log', requireAuth, new TransparencyLogAPI(transparencyLog).router);

  // Per-framework compliance bundles (SOC 2 / ISO 27001 / NIST AI RMF /
  // EU AI Act). Hands the auditor a signed, transparency-logged artifact
  // mapping each control to the AEGIS evidence that demonstrates it.
  const complianceBundles = new ComplianceBundleService(
    db, logger, detectors, coverageMap,
    new SigningService(db, logger),
    transparencyLog,
  );
  app.use('/api/v1/compliance', requireAuth, new ComplianceAPI(complianceBundles, auditLog).router);

  // LLM egress proxy — universal substrate for "any workflow" coverage.
  // Customer sets OPENAI_BASE_URL / ANTHROPIC_BASE_URL to this prefix and
  // every LLM call passes through detector chain + audit + transparency.
  // Auth: X-AEGIS-Key (their AEGIS key), Authorization / x-api-key forwarded
  // to upstream untouched (BYO key). Routes use app.all so any method
  // upstream supports (POST chat/completions, POST messages, etc.) works.
  const proxyHandler = new ProxyHandler({
    db, logger, detectors,
    audit: auditLog,
    adapters: [new OpenAIChatAdapter(), new AnthropicMessagesAdapter()],
    agentRegistry,
    crossAgent,
  });
  // NOTE: no `requireAuth` here — the proxy authenticates via X-AEGIS-Key
  // inside the handler since `Authorization` is reserved for the upstream
  // provider's key (BYOK pass-through). Mounted at /llm-proxy/* to avoid
  // collision with the MCP-server registry which owns /api/v1/proxy.
  app.all('/api/v1/llm-proxy/*', proxyHandler.handle);

  // Agent alignment auditor — LlamaFirewall-style CoT inspection.
  // Standalone for v0.3 preview; SDKs that capture chain-of-thought
  // call this pre-execution and pass alignment.* into /check.
  app.use('/api/v1/alignment', requireAuth, requireFeature('judge'), new AlignmentAPI(logger, auditLog, db).router);

  // CodeShield — fast local regex scanner for agent-generated code.
  // No LLM, no subprocess: every scan is sub-millisecond.
  app.use('/api/v1/code-shield', requireAuth, new CodeShieldAPI(logger, auditLog, db).router);

  // Audit-chain integrity — proves the "tamper-evident" claim by
  // recomputing each trace's hash and verifying the chain links.
  app.use('/api/v1/integrity', requireAuth, new IntegrityAPI(db, logger).router);

  // SOC 2 evidence pack — one-shot export of audit log + policies +
  // tenant config + integrity verdict, scoped to the requester's org.
  app.use('/api/v1/evidence-pack', requireAuth, new EvidencePackAPI(db, logger, auditLog).router);

  // SSO — sessions + IdP adapter. MockIdpAdapter is wired by default
  // so local dev + the test suite work end-to-end without WorkOS
  // credentials. Swap for WorkOSAdapter when the integration lands.
  const sessionService = new SessionService(db, logger);
  const idp = new MockIdpAdapter();
  app.use(
    '/api/v1/auth',
    requireAuth,
    new AuthAPI(db, logger, idp, sessionService, auditLog).router,
  );

  // Kill-switch endpoints (auth required)
  app.post('/api/v1/kill-switch/revoke', requireAuth, async (req, res) => {
    try {
      const { agent_id, reason } = req.body;
      if (!agent_id) return res.status(400).json({ error: { code: 'MISSING_FIELD', message: 'agent_id required' } });
      await killSwitch.revokeAgentAccess(agent_id, reason ?? 'Manual revocation');
      auditLog.log({
        org_id: req.orgId, action: 'killswitch.revoke', resource_type: 'agent',
        resource_id: agent_id, details: { reason }, ip_address: req.ip,
      });
      res.json({ success: true, agent_id, status: 'REVOKED' });
    } catch (e: any) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: e.message } });
    }
  });

  app.get('/api/v1/kill-switch', requireAuth, (req, res) => {
    try {
      const agents = db.prepare(`
        SELECT agent_id, status, revoked_at, revocation_reason, created_at
        FROM api_keys ORDER BY created_at DESC
      `).all();
      res.json({ agents });
    } catch (e: any) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: e.message } });
    }
  });

  // ── LLM-as-a-Judge endpoints ──────────────────────────────────────────────
  const llmJudge = new LLMJudgeService(db, logger);

  app.post('/api/v1/judge/trace/:traceId', requireAuth, requireFeature('judge'), async (req, res) => {
    try {
      const { provider, apiKey, model, dimensions } = req.body;
      if (!provider || !apiKey) {
        return res.status(400).json({ error: { code: 'MISSING_FIELD', message: 'provider and apiKey are required' } });
      }
      const verdict = await llmJudge.judgeTrace(req.params.traceId, {
        provider, apiKey, model, dimensions,
      });
      res.json(verdict);
    } catch (e: any) {
      res.status(e.message?.includes('not found') ? 404 : 500).json({ error: { code: 'JUDGE_ERROR', message: e.message } });
    }
  });

  app.post('/api/v1/judge/batch', requireAuth, requireFeature('judge'), async (req, res) => {
    try {
      const { provider, apiKey, model, dimensions, batchSize, concurrency, agentId, forceRejudge } = req.body;
      if (!provider || !apiKey) {
        return res.status(400).json({ error: { code: 'MISSING_FIELD', message: 'provider and apiKey are required' } });
      }
      const verdicts = await llmJudge.judgeBatch({
        provider, apiKey, model, dimensions, batchSize, concurrency, agentId, forceRejudge,
      });
      auditLog.log({
        org_id: req.orgId, action: 'judge.batch', resource_type: 'judge',
        details: { provider, judged: verdicts.length, batchSize, agentId },
        ip_address: req.ip,
      });
      res.json({
        judged: verdicts.length,
        avg_score: verdicts.length
          ? +(verdicts.reduce((s, v) => s + v.overall_score, 0) / verdicts.length).toFixed(2)
          : null,
        verdicts,
      });
    } catch (e: any) {
      res.status(500).json({ error: { code: 'JUDGE_ERROR', message: e.message } });
    }
  });

  app.get('/api/v1/judge/stats', requireAuth, requireFeature('judge'), (req, res) => {
    try {
      const agentId = req.query.agent_id as string | undefined;
      if (agentId) {
        res.json(llmJudge.getAgentStats(agentId));
      } else {
        res.json(llmJudge.getStats());
      }
    } catch (e: any) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: e.message } });
    }
  });

  app.get('/api/v1/judge/verdict/:traceId', requireAuth, (req, res) => {
    try {
      const verdict = db.prepare(
        'SELECT * FROM judge_verdicts WHERE trace_id = ?'
      ).get(req.params.traceId);
      if (!verdict) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No verdict found' } });
      res.json(verdict);
    } catch (e: any) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: e.message } });
    }
  });

  // Anomaly events endpoint (auth required)
  app.get('/api/v1/anomalies', requireAuth, requireFeature('anomaly'), (req, res) => {
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
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    }
  });

  // Seed demo data (auth required, dev only)
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
      res.status(500).json({ error: { code: 'SEED_ERROR', message: error.message } });
    }
  });

  // Stats endpoint (auth required)
  app.get('/api/v1/stats', requireAuth, (req, res) => {
    try {
      const totalTraces      = (db.prepare('SELECT COUNT(*) as n FROM traces').get() as any).n;
      const activeAgents     = (db.prepare("SELECT COUNT(DISTINCT agent_id) as n FROM traces WHERE timestamp > datetime('now', '-1 day')").get() as any).n;
      const rejectedCount    = (db.prepare("SELECT COUNT(*) as n FROM traces WHERE approval_status = 'REJECTED'").get() as any).n;

      let pendingChecks = 0;
      try {
        pendingChecks = (db.prepare("SELECT COUNT(*) as n FROM pending_checks WHERE decision = 'pending' AND expires_at > datetime('now')").get() as any).n;
      } catch (e) { logger.debug({ error: e }, 'pending_checks table not ready'); }

      let criticalCount = 0;
      try {
        criticalCount = (db.prepare("SELECT COUNT(*) as n FROM traces WHERE json_extract(safety_validation, '$.risk_level') IN ('CRITICAL', 'HIGH')").get() as any).n;
      } catch (e) { logger.debug({ error: e }, 'critical count query failed'); }

      const blockedAgents = (db.prepare("SELECT COUNT(DISTINCT agent_id) as n FROM traces WHERE approval_status = 'REJECTED'").get() as any).n;

      let violations24h = 0;
      try {
        violations24h = (db.prepare("SELECT COUNT(*) as n FROM violations WHERE created_at > datetime('now', '-1 day')").get() as any).n;
      } catch (e) { logger.debug({ error: e }, 'violations table not ready'); }

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
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    }
  });

  // ── Error middleware (must be last) ──────────────────────────────────────
  app.use(createErrorMiddleware(logger));

  // ── HTTP server ──────────────────────────────────────────────────────────
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
  const port = config.server.port;
  server.listen(port, () => {
    const bootMs = Date.now() - startTime;
    logger.info({
      port,
      version: VERSION,
      tier: config.license.tier,
      node_env: config.server.nodeEnv,
      anomaly: config.anomaly.enabled,
      otel: config.otel.enabled,
      boot_ms: bootMs,
    }, `AEGIS Gateway v${VERSION} ready (${bootMs}ms)`);
  });

  // ── Graceful shutdown ────────────────────────────────────────────────────
  let shuttingDown = false;

  function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Shutting down gracefully...');

    // Stop accepting new connections
    server.close(() => {
      logger.info('HTTP server closed');
    });

    // Force exit after timeout
    const forceExit = setTimeout(() => {
      logger.error('Forced shutdown — timeout exceeded');
      process.exit(1);
    }, config.server.shutdownTimeoutMs);
    forceExit.unref();

    // Cleanup services
    clearInterval(rateLimitCleanup);
    retention.stop();
    slaMetrics.stop();

    // Close WebSocket connections
    wss.clients.forEach(ws => ws.close(1001, 'Server shutting down'));
    wssAudit.clients.forEach(ws => ws.close(1001, 'Server shutting down'));

    // Close DB and OTel
    setTimeout(() => {
      db.close();
      shutdownOtel().finally(() => {
        logger.info('Shutdown complete');
        process.exit(0);
      });
    }, 1000); // Give in-flight requests 1s to drain
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Import FEATURE_GATES for gate messages
import { FEATURE_GATES } from './config';

main().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
