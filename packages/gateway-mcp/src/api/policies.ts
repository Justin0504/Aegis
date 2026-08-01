import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { z } from 'zod';
import { PolicyEngine } from '../policies/policy-engine';
import { AuditLogService } from '../services/audit-log';
import { listPacks, getPack } from '../policies/packs';

const CreatePolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  policy_schema: z.any(),
  risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
});

/** Resolve the requesting tenant. We honour, in priority order:
 *    1. req.orgId set by upstream auth middleware (real production path)
 *    2. X-Org-Id header (advanced ops / dogfood path)
 *    3. 'default' — solo-deploy fallback
 *  This mirrors WitnessAPI.orgIdOf so behaviour is uniform. */
function orgIdOf(req: Request): string {
  const fromCtx = (req as any).orgId;
  if (typeof fromCtx === 'string' && fromCtx) return fromCtx;
  const fromHeader = req.header('x-org-id');
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader;
  return 'default';
}

export class PolicyAPI {
  public readonly router: Router;

  constructor(
    private db: Database.Database,
    private policyEngine: PolicyEngine,
    private logger: Logger,
    /** Optional — when present, every mutation here lands in the
     *  audit_log. Older call-sites can omit it and the routes still
     *  function (no audit row written). New deployments inject it
     *  via server.ts; SOC 2 + ISO 27001 audit trails require it. */
    private auditLog?: AuditLogService,
  ) {
    this.router = Router();
    this.setupRoutes();
  }

  private setupRoutes() {
    // ── Vertical policy packs ────────────────────────────────────────────
    // List available packs (no auth required for metadata; install does)
    this.router.get('/packs', async (_req: Request, res: Response) => {
      res.json({ packs: listPacks() })
    })

    // Rule hit-rate — per-rule fire counts over three windows (24h,
    // 7d, all time) plus last-fired timestamp. Read from the
    // violations table populated by check.ts when a DSL rule blocks
    // or holds a call. Powers the /policies "hit rate" panel.
    this.router.get('/hit-rate', async (req: Request, res: Response) => {
      try {
        const now = Date.now();
        const cutoff24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
        const cutoff7d  = new Date(now -  7 * 24 * 60 * 60 * 1000).toISOString();
        const rows = this.db.prepare(`
          SELECT
            policy_id        AS rule_name,
            COUNT(*)         AS total,
            SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS h24,
            SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS d7,
            SUM(CASE WHEN violation_type = 'dsl_block'   THEN 1 ELSE 0 END) AS blocks,
            SUM(CASE WHEN violation_type = 'dsl_pending' THEN 1 ELSE 0 END) AS pendings,
            MAX(created_at)  AS last_fired
          FROM violations
          WHERE violation_type IN ('dsl_block', 'dsl_pending')
          GROUP BY policy_id
          ORDER BY total DESC, last_fired DESC
        `).all(cutoff24h, cutoff7d);
        res.json({ rules: rows });
      } catch (err) {
        this.logger.error({ err }, 'hit-rate query failed');
        res.status(500).json({ error: 'query failed' });
      }
    })

    // Preview a pack's policies before install
    this.router.get('/packs/:slug', async (req: Request, res: Response) => {
      const pack = getPack(req.params.slug)
      if (!pack) return res.status(404).json({ error: `Unknown pack: ${req.params.slug}` })
      res.json(pack)
    })

    // Install a pack — batch-inserts its policies as this tenant's overrides.
    // Skip already-installed policies (matching id, same tenant) silently.
    this.router.post('/packs/:slug/install', async (req: Request, res: Response) => {
      const pack = getPack(req.params.slug)
      if (!pack) return res.status(404).json({ error: `Unknown pack: ${req.params.slug}` })
      const orgId = orgIdOf(req)
      const existing = new Set((await this.policyEngine.getAllPolicies(orgId)).map((p: any) => p.id))
      const created: string[] = []
      const skipped: string[] = []
      for (const policy of pack.policies) {
        if (existing.has(policy.id)) { skipped.push(policy.id); continue }
        try {
          await this.policyEngine.addPolicy(policy as any, orgId)
          created.push(policy.id)
        } catch (e: any) {
          this.logger.warn({ pack: pack.slug, policy: policy.id, err: e.message }, 'pack install: policy add failed')
        }
      }
      this.auditLog?.log({
        org_id: orgId, action: 'policy.pack_install', resource_type: 'policy',
        resource_id: pack.slug,
        details: { name: pack.name, created_count: created.length, skipped_count: skipped.length },
        ip_address: req.ip,
      })
      res.status(201).json({ pack: pack.slug, created, skipped, total: pack.policies.length })
    })

    // List policies — wildcard platform defaults + this tenant's overrides
    this.router.get('/', async (req: Request, res: Response) => {
      try {
        const policies = await this.policyEngine.getAllPolicies(orgIdOf(req));
        res.json(policies);
      } catch (error) {
        this.logger.error({ error }, 'Failed to list policies');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Create new policy
    this.router.post('/', async (req: Request, res: Response) => {
      try {
        const policy = CreatePolicySchema.parse(req.body);
        const orgId = orgIdOf(req);
        await this.policyEngine.addPolicy(policy as any, orgId);
        this.auditLog?.log({
          org_id: orgId, action: 'policy.create', resource_type: 'policy',
          resource_id: policy.id,
          details: { name: policy.name, risk_level: policy.risk_level },
          ip_address: req.ip,
        });
        res.status(201).json({ id: policy.id });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ error: 'Invalid policy format', details: error.errors });
        }
        this.logger.error({ error }, 'Failed to create policy');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Enable policy
    this.router.put('/:policyId/enable', async (req: Request, res: Response) => {
      try {
        const orgId = orgIdOf(req);
        await this.policyEngine.enablePolicy(req.params.policyId, orgId);
        this.auditLog?.log({
          org_id: orgId, action: 'policy.toggle', resource_type: 'policy',
          resource_id: req.params.policyId, details: { enabled: true },
          ip_address: req.ip,
        });
        res.json({ status: 'enabled' });
      } catch (error) {
        this.logger.error({ error }, 'Failed to enable policy');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Disable policy
    this.router.put('/:policyId/disable', async (req: Request, res: Response) => {
      try {
        const orgId = orgIdOf(req);
        await this.policyEngine.disablePolicy(req.params.policyId, orgId);
        this.auditLog?.log({
          org_id: orgId, action: 'policy.toggle', resource_type: 'policy',
          resource_id: req.params.policyId, details: { enabled: false },
          ip_address: req.ip,
        });
        res.json({ status: 'disabled' });
      } catch (error) {
        this.logger.error({ error }, 'Failed to disable policy');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Delete policy
    this.router.delete('/:policyId', async (req: Request, res: Response) => {
      try {
        const orgId = orgIdOf(req);
        await this.policyEngine.deletePolicy(req.params.policyId, orgId);
        this.auditLog?.log({
          org_id: orgId, action: 'policy.delete', resource_type: 'policy',
          resource_id: req.params.policyId,
          ip_address: req.ip,
        });
        res.json({ status: 'deleted' });
      } catch (error) {
        this.logger.error({ error }, 'Failed to delete policy');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Test policy against tool call
    this.router.post('/test', async (req: Request, res: Response) => {
      try {
        const { tool, arguments: args } = req.body;
        const validation = await this.policyEngine.validateToolCall(
          { tool, arguments: args },
          orgIdOf(req),
        );
        res.json(validation);
      } catch (error) {
        this.logger.error({ error }, 'Failed to test policy');
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  }
}