/**
 * Pre-execution check endpoint — supports both fast-path and blocking mode.
 *
 * Fast-path (default):
 *   POST /api/v1/check  →  { decision: "allow" | "block", ... }
 *   Returns immediately. Agent runs or skips the tool.
 *
 * Blocking / human-in-the-loop:
 *   POST /api/v1/check  (with blocking: true)
 *   → If safe:     { decision: "allow", ... }
 *   → If risky:    { decision: "pending", check_id }
 *   Agent polls:
 *   GET  /api/v1/check/:checkId/decision
 *   → { decision: "allow" | "block" }
 *   Human approves/rejects in dashboard:
 *   PATCH /api/v1/check/:checkId  { decision: "allow" | "block", decided_by? }
 *   Dashboard lists pending:
 *   GET  /api/v1/check/pending
 */

import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { PolicyEngine } from '../policies/policy-engine';
import { ToolCategory } from '../services/classifier';
import { WebhookService } from '../services/webhooks';
import { EventBus } from '../services/event-bus';
import { AnomalyDetector, AnomalyResult } from '../services/anomaly-detector';
import { ProfileManager } from '../services/profile-manager';
import { SlidingWindowStats } from '../services/sliding-window';
import { DslPolicyService } from '../services/policy-dsl';
import { TenantConfigService } from '../services/tenant-config';
import { MatchResult } from '../policies/dsl/evaluator';
import { GatewayMetricsService } from '../services/gateway-metrics';
import { setSpanAttributes, emitGuardrailSpan } from '../services/otel';

// ── Schema ────────────────────────────────────────────────────────────────────

const CheckRequestSchema = z.object({
  agent_id:    z.string(),
  tool_name:   z.string(),
  arguments:   z.record(z.unknown()).default({}),
  environment: z.string().optional(),
  /**
   * When true: HIGH/CRITICAL risk tools are held as PENDING
   * and the agent must poll for a human decision.
   */
  blocking:    z.boolean().default(false),
  /**
   * User-declared category overrides — { "my_tool": "database" }
   * Highest priority, overrides auto-classification.
   */
  user_category_overrides: z.record(z.string()).optional(),
  /**
   * Optional agent-alignment evidence captured by an SDK that has
   * chain-of-thought visibility (LangChain/CrewAI/ReAct). If present,
   * the score + drift flag are fed into the DSL evaluator so rules
   * can match on `alignment.score < 0.5` etc. Compute it via
   * POST /api/v1/alignment/check upstream of /check.
   */
  alignment: z.object({
    score:    z.number().min(0).max(1),
    drifted:  z.boolean().optional(),
    signals:  z.array(z.string().max(40)).max(5).optional(),
    reason:   z.string().max(500).optional(),
  }).optional(),
  /**
   * Optional CodeShield evidence — only present when the caller is a
   * code-generating agent and has run /api/v1/code-shield/scan on the
   * code it's about to commit or exec. Drives DSL rules like
   * `code_shield.worst == "CRITICAL"`.
   */
  code_shield: z.object({
    worst:           z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).nullable().optional(),
    findings_count:  z.number().int().nonnegative().optional(),
    rules:           z.array(z.string().max(80)).max(64).optional(),
  }).optional(),
})

// Risk levels that trigger human-review when blocking=true
const BLOCKING_RISK_LEVELS = new Set(['HIGH', 'CRITICAL'])

export class CheckAPI {
  public readonly router: Router

  constructor(
    private db: Database.Database,
    private policyEngine: PolicyEngine,
    private logger: Logger,
    private webhooks?: WebhookService,
    public readonly eventBus: EventBus = new EventBus(),
    private anomalyDetector?: AnomalyDetector,
    private profileManager?: ProfileManager,
    private slidingWindow?: SlidingWindowStats,
    private dslPolicy?: DslPolicyService,
    private tenantConfig?: TenantConfigService,
    private agentRegistry?: import('../services/agent-registry').AgentRegistryService,
    private gatewayMetrics?: GatewayMetricsService,
  ) {
    this.router = Router()
    this.initTable()
    this.setupRoutes()
  }

  private initTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_checks (
        check_id    TEXT PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        arguments   TEXT NOT NULL,
        category    TEXT NOT NULL,
        risk_level  TEXT NOT NULL,
        signals     TEXT,
        violations  TEXT,
        decision    TEXT NOT NULL DEFAULT 'pending',
        decided_by  TEXT,
        decided_at  TEXT,
        created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_decision ON pending_checks (decision, expires_at);
      CREATE INDEX IF NOT EXISTS idx_pending_agent ON pending_checks (agent_id, decision);
    `)
  }

  private setupRoutes() {

    // ── POST /  — main check ─────────────────────────────────────────────────
    this.router.post('/', async (req: Request, res: Response) => {
      const start = Date.now()
      try {
        const body = CheckRequestSchema.parse(req.body)

        // Register the sighting so first-call traffic flips the
        // onboarding wizard's "waiting" panel and the agents table
        // gets a row even before any trace is ingested.
        if (this.agentRegistry) {
          const orgId = (req as any).orgId ?? 'default';
          const buildArtifact = req.headers['x-aegis-build-artifact'] as string | undefined;
          const sourceCommit  = req.headers['x-aegis-source-commit']  as string | undefined;
          const provenance = (buildArtifact || sourceCommit)
            ? { build_artifact: buildArtifact, source_commit: sourceCommit }
            : undefined;
          this.agentRegistry.touch({ orgId, agentId: body.agent_id, provenance });

          // Capability attestation gate — refuses a tool call whose name
          // isn't in the agent's declared_tools list. Opt-in: agents with
          // no declared_tools set skip this check entirely, so existing
          // installations don't regress.
          const cap = this.agentRegistry.checkCapability({
            agentId:  body.agent_id,
            toolName: body.tool_name,
          });
          if (!cap.allowed) {
            const checkId = randomUUID();
            const latencyMs = Date.now() - start;
            return res.json({
              decision: 'block',
              reason:   cap.reason,
              check_id: checkId,
              risk_level: 'HIGH',
              category:  'unattested-tool',
              latency_ms: latencyMs,
            });
          }
        }

        // user_category_overrides from client is ignored for security —
        // a compromised agent could reclassify dangerous tools to bypass policies.
        // Category overrides should be configured server-side only.
        const requestOrgId = (req as any).orgId ?? 'default'
        const validation = await this.policyEngine.validateToolCall(
          { tool: body.tool_name, arguments: body.arguments },
          requestOrgId,
        )

        const { classification } = validation
        const checkId = randomUUID()

        // ── Layer 2: Behavioral anomaly detection ──────────────────────────
        let anomalyResult: AnomalyResult | null = null
        if (this.anomalyDetector && this.profileManager && this.slidingWindow) {
          const profile = this.profileManager.getProfile(body.agent_id)
          const phase = this.profileManager.getPhase(body.agent_id)

          // Trigger async profile rebuild if stale
          if (this.profileManager.shouldRebuild(body.agent_id)) {
            this.profileManager.rebuildOne(body.agent_id).catch(err =>
              this.logger.warn({ err, agent_id: body.agent_id }, 'Async profile rebuild failed')
            )
          }

          if (profile && phase !== 'learning') {
            anomalyResult = this.anomalyDetector.evaluate(
              body.agent_id,
              body.tool_name,
              body.arguments as Record<string, unknown>,
              profile,
              validation.risk_level as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
            )

            // Record in sliding window for future evaluations
            this.slidingWindow.record(body.agent_id, {
              timestamp: Date.now(),
              tool_name: body.tool_name,
              risk_level: validation.risk_level as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
              cost_usd: 0,
              arg_length: JSON.stringify(body.arguments).length,
            })

            // Persist anomaly events above flag threshold (async, non-blocking)
            if (anomalyResult.composite_score > 0.3) {
              this.db.prepare(`
                INSERT INTO anomaly_events (agent_id, check_id, composite_score, decision, signals)
                VALUES (?, ?, ?, ?, ?)
              `).run(
                body.agent_id, checkId, anomalyResult.composite_score,
                anomalyResult.decision, JSON.stringify(anomalyResult.signals),
              )

              // Store feature vector for feedback loop
              if (anomalyResult.feature_vector) {
                try {
                  this.db.prepare(`
                    INSERT INTO anomaly_feedback (check_id, agent_id, composite_score, feature_vector, model_decision)
                    VALUES (?, ?, ?, ?, ?)
                  `).run(
                    checkId, body.agent_id, anomalyResult.composite_score,
                    JSON.stringify(anomalyResult.feature_vector), anomalyResult.decision,
                  )
                } catch { /* best-effort, table may not exist on old DBs */ }
              }
            }

            // In graduated phase, cap anomaly decision at 'flag' (no blocking)
            if (phase === 'graduated' && anomalyResult.decision !== 'pass') {
              anomalyResult = { ...anomalyResult, decision: 'flag' }
            }

            this.logger.debug({
              agent_id: body.agent_id,
              anomaly_score: anomalyResult.composite_score,
              anomaly_decision: anomalyResult.decision,
              phase,
              signals: anomalyResult.signals.length,
            }, 'Anomaly evaluation')

            // Incremental EWMA profile update (online learning)
            this.profileManager!.onTrace(body.agent_id, {
              toolName: body.tool_name,
              args: body.arguments as Record<string, unknown>,
              riskLevel: validation.risk_level,
              costUsd: 0,
              tokens: 0,
              timestampMs: Date.now(),
            })

            // Fire webhook/event for anomaly escalate/block
            if (anomalyResult.decision === 'escalate' || anomalyResult.decision === 'block') {
              const anomalyTs = new Date().toISOString()
              this.webhooks?.fire({
                event: `anomaly.${anomalyResult.decision}`,
                check_id: checkId,
                agent_id: body.agent_id,
                tool_name: body.tool_name,
                category: classification.category,
                risk_level: validation.risk_level,
                anomaly_score: anomalyResult.composite_score,
                top_signal: anomalyResult.signals[0]?.type,
                reason: `Behavioral anomaly: ${anomalyResult.signals[0]?.detail ?? 'deviation detected'}`,
                timestamp: anomalyTs,
              })
              this.eventBus.push({
                id: checkId,
                event: `anomaly.${anomalyResult.decision}`,
                agent_id: body.agent_id,
                tool_name: body.tool_name,
                category: classification.category,
                risk_level: validation.risk_level,
                anomaly_score: anomalyResult.composite_score,
                reason: `Behavioral anomaly: ${anomalyResult.signals[0]?.detail ?? 'deviation detected'}`,
                timestamp: anomalyTs,
              })
            }
          }
        }

        // ── Merge policy + anomaly decisions ───────────────────────────────
        // Policy block always wins (hard security boundary).
        // Anomaly can escalate an otherwise-allowed call.
        let isRisky = BLOCKING_RISK_LEVELS.has(validation.risk_level) && !validation.passed

        // Anomaly-driven escalation
        if (anomalyResult) {
          if (anomalyResult.decision === 'block' && validation.passed) {
            // Anomaly alone blocks — override the policy pass
            isRisky = true
          }
          if (anomalyResult.decision === 'escalate') {
            isRisky = true
          }
        }

        // ── Per-tenant DSL evaluation (fail-safe: only tightens) ────────────
        let dslMatch: MatchResult | null = null
        if (this.dslPolicy) {
          const orgId = (req as any).orgId ?? 'default'
          const deploymentMode =
            this.tenantConfig?.get(orgId).deploymentMode ?? 'standard'
          dslMatch = this.dslPolicy.evaluate(orgId, {
            classifier: {
              category: classification.category,
              signals: classification.signals,
              risks: classification.risks as any,
            },
            anomaly: anomalyResult
              ? {
                  score: anomalyResult.composite_score,
                  decision: anomalyResult.decision,
                }
              : undefined,
            // Optional alignment evidence — only present if the caller
            // pre-computed it via /api/v1/alignment/check.
            alignment: body.alignment ?? undefined,
            // Optional CodeShield evidence — only present if the caller
            // pre-scanned generated code via /api/v1/code-shield/scan.
            code_shield: body.code_shield ?? undefined,
            policy: {
              passed: validation.passed,
              riskLevel: validation.risk_level,
              violations: validation.violations ?? [],
            },
            tool: { name: body.tool_name, args: body.arguments as Record<string, unknown> },
            agent: { id: body.agent_id },
            tenant: { id: orgId, deploymentMode },
          })
          if (dslMatch && (dslMatch.decision === 'block' || dslMatch.decision === 'pending')) {
            isRisky = true
          }
        }
        const dslBlocks = dslMatch?.decision === 'block'
        const dslPending = dslMatch?.decision === 'pending'

        // Communication tools (email, messaging) always require human review in blocking mode
        const requiresHumanReview = classification.category === 'communication'

        // ── BLOCKING MODE: hold for human review ─────────────────────────────
        if (body.blocking && (isRisky || requiresHumanReview)) {
          const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 min

          this.db.prepare(`
            INSERT INTO pending_checks
              (check_id, agent_id, tool_name, arguments, category, risk_level, signals, violations, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            checkId,
            body.agent_id,
            body.tool_name,
            JSON.stringify(body.arguments),
            classification.category,
            requiresHumanReview ? 'HIGH' : validation.risk_level,
            JSON.stringify(classification.signals),
            JSON.stringify(requiresHumanReview ? ['Requires human approval'] : (validation.violations ?? [])),
            expiresAt,
          )

          this.logger.warn({
            check_id: checkId,
            agent_id: body.agent_id,
            tool: body.tool_name,
            category: classification.category,
            risk_level: validation.risk_level,
          }, 'Check PENDING — awaiting human review')

          const pendingTs = new Date().toISOString()
          this.webhooks?.fire({
            event: 'pending', check_id: checkId,
            agent_id: body.agent_id, tool_name: body.tool_name,
            category: classification.category, risk_level: validation.risk_level,
            reason: validation.violations?.[0],
            timestamp: pendingTs,
          })
          this.eventBus.push({
            id: checkId, event: 'pending',
            agent_id: body.agent_id, tool_name: body.tool_name,
            category: classification.category, risk_level: validation.risk_level,
            reason: validation.violations?.[0],
            timestamp: pendingTs,
          })

          this.gatewayMetrics?.recordCheck('pending', requestOrgId)
          return res.json({
            decision:   'pending',
            check_id:   checkId,
            risk_level: validation.risk_level,
            category:   classification.category,
            reason:     dslMatch?.reason
              ?? (anomalyResult?.decision === 'escalate'
                ? `Behavioral anomaly detected (score=${anomalyResult.composite_score})`
                : (validation.violations?.[0] ?? 'Requires human review')),
            anomaly: anomalyResult ? {
              score: anomalyResult.composite_score,
              decision: anomalyResult.decision,
              signals: anomalyResult.signals.length,
            } : undefined,
            dsl: dslMatch ? {
              decision: dslMatch.decision,
              rule: dslMatch.ruleName,
              reason: dslMatch.reason,
            } : undefined,
            latency_ms: Date.now() - start,
          })
        }

        // ── FAST-PATH: auto decision ──────────────────────────────────────────
        // Anomaly can override policy pass to block.
        // DSL is fail-safe — block forces block; pending collapses to block
        // (fast-path callers opted out of pending semantics).
        let decision: 'allow' | 'block' = validation.passed ? 'allow' : 'block'
        if (decision === 'allow' && anomalyResult?.decision === 'block') {
          decision = 'block'
        }
        if (decision === 'allow' && (dslBlocks || dslPending)) {
          decision = 'block'
        }

        if (decision === 'block') {
          const blockTs = new Date().toISOString()
          this.webhooks?.fire({
            event: 'block', check_id: checkId,
            agent_id: body.agent_id, tool_name: body.tool_name,
            category: classification.category, risk_level: validation.risk_level,
            reason: validation.violations?.[0],
            timestamp: blockTs,
          })
          this.eventBus.push({
            id: checkId, event: 'block',
            agent_id: body.agent_id, tool_name: body.tool_name,
            category: classification.category, risk_level: validation.risk_level,
            reason: validation.violations?.[0],
            timestamp: blockTs,
          })
        }

        this.logger.info({
          check_id:   checkId,
          agent_id:   body.agent_id,
          tool:       body.tool_name,
          category:   classification.category,
          source:     classification.source,
          risk_level: validation.risk_level,
          decision,
          latency_ms: Date.now() - start,
        }, `Pre-check ${decision.toUpperCase()}`)
        this.gatewayMetrics?.recordCheck(decision, requestOrgId)
        if (anomalyResult?.decision === 'block') this.gatewayMetrics?.recordAnomaly(requestOrgId)
        // Distributed-trace attributes — picked up by the customer's
        // OTel collector if they configured OTEL_EXPORTER_OTLP_ENDPOINT.
        setSpanAttributes({
          org_id:     requestOrgId,
          agent_id:   body.agent_id,
          tool_name:  body.tool_name,
          decision,
          risk_level: validation.risk_level,
          category:   classification.category,
        })
        // GenAI semconv guardrail extension — surfaces a dedicated span
        // each time the gateway makes a decision so the customer's APM
        // (Datadog / Honeycomb / Grafana) shows "Guardrail Violations"
        // out of the box. Emitted fire-and-forget; failure cannot block
        // the check response.
        emitGuardrailSpan({
          decision,
          policy: validation.policy_name,
          category: classification.category,
          riskLevel: validation.risk_level,
          reason: decision === 'block' ? (validation.violations?.[0] ?? 'policy violation') : undefined,
          orgId: requestOrgId,
          agentId: body.agent_id,
        })

        return res.json({
          decision,
          check_id:   checkId,
          risk_level: validation.risk_level,
          category:   classification.category,
          signals:    classification.signals,
          reason:     decision === 'block'
            ? (dslBlocks
              ? (dslMatch?.reason ?? `DSL rule ${dslMatch?.ruleName} blocked`)
              : anomalyResult?.decision === 'block'
                ? `Behavioral anomaly (score=${anomalyResult.composite_score})`
                : (validation.violations?.[0] ?? 'Policy violation'))
            : undefined,
          anomaly: anomalyResult ? {
            score: anomalyResult.composite_score,
            decision: anomalyResult.decision,
            signals: anomalyResult.signals.length,
          } : undefined,
          dsl: dslMatch ? {
            decision: dslMatch.decision,
            rule: dslMatch.ruleName,
            reason: dslMatch.reason,
          } : undefined,
          latency_ms: Date.now() - start,
        })

      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ error: 'Invalid request', details: error.errors })
        }
        this.logger.error({ error }, 'Check endpoint error')
        // Fail-closed: gateway errors block by default for safety
        return res.json({
          decision:   'block',
          check_id:   randomUUID(),
          risk_level: 'CRITICAL',
          reason:     'Gateway error — fail-closed',
          latency_ms: Date.now() - start,
        })
      }
    })

    // ── GET /pending  — dashboard list ───────────────────────────────────────
    this.router.get('/pending', (req: Request, res: Response) => {
      try {
        const { agent_id } = req.query as Record<string, string>
        let sql = `SELECT * FROM pending_checks WHERE decision = 'pending' AND expires_at > datetime('now')`
        const params: any[] = []
        if (agent_id) { sql += ' AND agent_id = ?'; params.push(agent_id) }
        sql += ' ORDER BY created_at DESC LIMIT 100'

        const rows = this.db.prepare(sql).all(...params) as any[]
        res.json({
          checks: rows.map(r => ({
            ...r,
            arguments: JSON.parse(r.arguments),
            signals: r.signals ? JSON.parse(r.signals) : [],
            violations: r.violations ? JSON.parse(r.violations) : [],
          })),
          total: rows.length,
        })
      } catch (error) {
        this.logger.error({ error }, 'Failed to list pending checks')
        res.status(500).json({ error: 'Internal server error' })
      }
    })

    // ── GET /:checkId/decision  — SDK polls this ─────────────────────────────
    this.router.get('/:checkId/decision', (req: Request, res: Response) => {
      try {
        const row = this.db.prepare(
          'SELECT decision, risk_level, decided_by FROM pending_checks WHERE check_id = ?'
        ).get(req.params.checkId) as any

        if (!row) {
          return res.status(404).json({ error: 'Check not found' })
        }

        // Check expired — auto-block for safety
        if (row.decision === 'pending') {
          const expired = this.db.prepare(
            `SELECT 1 FROM pending_checks WHERE check_id = ? AND expires_at <= datetime('now')`
          ).get(req.params.checkId)

          if (expired) {
            this.db.prepare(
              `UPDATE pending_checks SET decision = 'block', decided_by = 'timeout' WHERE check_id = ?`
            ).run(req.params.checkId)
            return res.json({ decision: 'block', reason: 'Approval timed out' })
          }
        }

        res.json({
          decision:   row.decision,
          risk_level: row.risk_level,
          decided_by: row.decided_by,
        })
      } catch (error) {
        this.logger.error({ error }, 'Failed to get check decision')
        res.status(500).json({ error: 'Internal server error' })
      }
    })

    // ── PATCH /:checkId  — human approves or rejects ─────────────────────────
    this.router.patch('/:checkId', (req: Request, res: Response) => {
      try {
        const { decision, decided_by } = req.body
        if (!['allow', 'block'].includes(decision)) {
          return res.status(400).json({ error: 'decision must be "allow" or "block"' })
        }

        // Wrap the SELECT → UPDATE pending_checks → UPDATE anomaly_feedback
        // chain in a single transaction so two concurrent PATCHes on the
        // same check_id can't observe inconsistent intermediate state.
        // better-sqlite3 transactions are synchronous + reentrant; the
        // returned closure runs the whole block atomically (BEGIN
        // IMMEDIATE under the hood). Either every row updates or none do.
        const tx = this.db.transaction(() => {
          const check = this.db.prepare(
            'SELECT agent_id, tool_name, arguments FROM pending_checks WHERE check_id = ?'
          ).get(req.params.checkId) as { agent_id: string; tool_name: string; arguments: string } | undefined

          const result = this.db.prepare(`
            UPDATE pending_checks
            SET decision = ?, decided_by = ?, decided_at = datetime('now')
            WHERE check_id = ? AND decision = 'pending'
          `).run(decision, decided_by ?? 'dashboard-user', req.params.checkId)

          if (result.changes === 0) {
            return { ok: false as const }
          }

          // Read the stored feature vector inside the tx so the
          // accompanying UPDATE anomaly_feedback below commits with
          // the same view of the row that drove this decision.
          let feedbackRow: { feature_vector: string } | undefined
          if (check) {
            feedbackRow = this.db.prepare(
              'SELECT feature_vector FROM anomaly_feedback WHERE check_id = ?'
            ).get(req.params.checkId) as any
            if (feedbackRow) {
              this.db.prepare(
                'UPDATE anomaly_feedback SET human_decision = ?, decided_at = datetime(\'now\') WHERE check_id = ?'
              ).run(decision, req.params.checkId)
            }
          }
          return { ok: true as const, check, feedbackRow }
        })

        const txResult = tx()
        if (!txResult.ok) {
          return res.status(404).json({ error: 'Check not found or already decided' })
        }

        // ── Feedback loop: flow human decision back to anomaly model ──────
        // Done OUTSIDE the tx because anomalyDetector.ingestFeedback is
        // an in-memory mutation (not transactional), and we want it to
        // run after the row is durably committed — never before.
        if (txResult.check && txResult.feedbackRow && this.anomalyDetector && this.profileManager) {
          const profile = this.profileManager.getProfile(txResult.check.agent_id)
          if (profile) {
            try {
              const featureVector = JSON.parse(txResult.feedbackRow.feature_vector) as number[]
              this.anomalyDetector.ingestFeedback(
                txResult.check.agent_id, profile, featureVector, decision === 'allow',
              )
            } catch { /* best-effort feedback */ }
          }
        }
        const check = txResult.check

        this.logger.info({
          check_id:   req.params.checkId,
          decision,
          decided_by: decided_by ?? 'dashboard-user',
        }, `Check decided: ${decision.toUpperCase()}`)

        res.json({ check_id: req.params.checkId, decision })
      } catch (error) {
        this.logger.error({ error }, 'Failed to decide check')
        res.status(500).json({ error: 'Internal server error' })
      }
    })

    // ── GET /events  — real-time block/pending event feed (poll) ─────────────
    this.router.get('/events', (req: Request, res: Response) => {
      const since = req.query.since as string | undefined
      res.json({ events: this.eventBus.since(since) })
    })

    // ── GET /history  — recent decided checks ────────────────────────────────
    this.router.get('/history', (req: Request, res: Response) => {
      try {
        const limit = Number(req.query.limit ?? 50)
        const rows = this.db.prepare(`
          SELECT * FROM pending_checks
          WHERE decision != 'pending'
          ORDER BY decided_at DESC LIMIT ?
        `).all(limit) as any[]

        res.json({
          checks: rows.map(r => ({
            ...r,
            arguments: JSON.parse(r.arguments),
            signals: r.signals ? JSON.parse(r.signals) : [],
            violations: r.violations ? JSON.parse(r.violations) : [],
          })),
        })
      } catch (error) {
        res.status(500).json({ error: 'Internal server error' })
      }
    })
  }
}
