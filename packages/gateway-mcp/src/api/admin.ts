/**
 * Enterprise admin API — organizations, users, API keys, audit log,
 * retention policies, usage metering, SLA metrics.
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import Database from 'better-sqlite3';
import { RBACService, Role } from '../services/rbac';
import { AuditLogService } from '../services/audit-log';
import { RetentionService } from '../services/retention';
import { UsageMeteringService } from '../services/usage-metering';
import { SLAMetricsService } from '../services/sla-metrics';

export class AdminAPI {
  public router: Router;

  constructor(
    private db: Database.Database,
    private logger: Logger,
    private rbac: RBACService,
    private auditLog: AuditLogService,
    private retention: RetentionService,
    private usage: UsageMeteringService,
    private sla: SLAMetricsService,
  ) {
    this.router = Router();
    this.setupRoutes();
  }

  private setupRoutes() {
    // ── Organizations ──────────────────────────────────────────────────────
    this.router.get('/orgs', (req: Request, res: Response) => {
      try {
        res.json({ organizations: this.rbac.listOrgs() });
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    this.router.post('/orgs', (req: Request, res: Response) => {
      try {
        const { name, slug, plan } = req.body;
        if (!name || !slug) return res.status(400).json({ error: 'name and slug required' });

        const orgId = this.rbac.createOrg(name, slug, plan || 'free');
        // Create default API key for the new org
        const keyResult = this.rbac.createApiKey(orgId, { name: 'Default Key' });

        this.auditLog.log({
          action: 'org.create',
          resource_type: 'organization',
          resource_id: orgId,
          details: { name, slug, plan: plan || 'free' },
          ip_address: req.ip,
        });

        res.status(201).json({ org_id: orgId, api_key: keyResult.key, key_prefix: keyResult.prefix });
      } catch (e: any) {
        if (e.message?.includes('UNIQUE')) {
          return res.status(409).json({ error: 'Organization slug already exists' });
        }
        res.status(500).json({ error: e.message });
      }
    });

    this.router.get('/orgs/:orgId', (req: Request, res: Response) => {
      try {
        const org = this.rbac.getOrg(req.params.orgId);
        if (!org) return res.status(404).json({ error: 'Organization not found' });
        res.json(org);
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    this.router.patch('/orgs/:orgId', (req: Request, res: Response) => {
      try {
        const { plan, settings } = req.body;
        if (plan) this.rbac.updateOrgPlan(req.params.orgId, plan);
        if (settings) this.rbac.updateOrgSettings(req.params.orgId, settings);

        this.auditLog.log({
          org_id: req.params.orgId,
          action: plan ? 'org.update' : 'org.settings',
          resource_type: 'organization',
          resource_id: req.params.orgId,
          details: req.body,
          ip_address: req.ip,
        });

        res.json({ success: true });
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    // ── Users ──────────────────────────────────────────────────────────────
    this.router.get('/orgs/:orgId/users', (req: Request, res: Response) => {
      try {
        res.json({ users: this.rbac.listUsers(req.params.orgId) });
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    this.router.post('/orgs/:orgId/users', (req: Request, res: Response) => {
      try {
        const { email, role, name } = req.body;
        if (!email || !role) return res.status(400).json({ error: 'email and role required' });

        const validRoles: Role[] = ['owner', 'admin', 'auditor', 'viewer'];
        if (!validRoles.includes(role)) {
          return res.status(400).json({ error: `Invalid role. Must be: ${validRoles.join(', ')}` });
        }

        const user = this.rbac.createUser(req.params.orgId, email, role, name);

        this.auditLog.log({
          org_id: req.params.orgId,
          action: 'user.create',
          resource_type: 'user',
          resource_id: user.id,
          details: { email, role },
          ip_address: req.ip,
        });

        res.status(201).json(user);
      } catch (e: any) {
        if (e.message?.includes('UNIQUE')) {
          return res.status(409).json({ error: 'User with this email already exists in this organization' });
        }
        res.status(500).json({ error: e.message });
      }
    });

    this.router.patch('/orgs/:orgId/users/:userId', (req: Request, res: Response) => {
      try {
        const { role, status } = req.body;
        if (role) this.rbac.updateUserRole(req.params.userId, role);
        if (status === 'deactivated') this.rbac.deactivateUser(req.params.userId);

        this.auditLog.log({
          org_id: req.params.orgId,
          action: 'user.update',
          resource_type: 'user',
          resource_id: req.params.userId,
          details: req.body,
          ip_address: req.ip,
        });

        res.json({ success: true });
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    // ── API Keys ───────────────────────────────────────────────────────────
    this.router.get('/orgs/:orgId/keys', (req: Request, res: Response) => {
      try {
        res.json({ keys: this.rbac.listApiKeys(req.params.orgId) });
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    this.router.post('/orgs/:orgId/keys', (req: Request, res: Response) => {
      try {
        const { name, scopes, rate_limit, expires_in_days } = req.body;
        const result = this.rbac.createApiKey(req.params.orgId, {
          name, scopes, rateLimit: rate_limit, expiresInDays: expires_in_days,
        });

        this.auditLog.log({
          org_id: req.params.orgId,
          action: 'apikey.create',
          resource_type: 'apikey',
          resource_id: result.keyId,
          details: { name, prefix: result.prefix },
          ip_address: req.ip,
        });

        res.status(201).json({ key: result.key, key_id: result.keyId, prefix: result.prefix });
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    this.router.delete('/orgs/:orgId/keys/:keyId', (req: Request, res: Response) => {
      try {
        this.rbac.revokeApiKey(req.params.keyId);

        this.auditLog.log({
          org_id: req.params.orgId,
          action: 'apikey.revoke',
          resource_type: 'apikey',
          resource_id: req.params.keyId,
          ip_address: req.ip,
        });

        res.json({ success: true });
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    // ── Audit Log ──────────────────────────────────────────────────────────
    this.router.get('/audit-log', (req: Request, res: Response) => {
      try {
        const { org_id, action, resource_type, from, to, limit, offset } = req.query as Record<string, string>;
        const result = this.auditLog.query({
          org_id, action, resource_type, from, to,
          limit: limit ? parseInt(limit, 10) : undefined,
          offset: offset ? parseInt(offset, 10) : undefined,
        });
        res.json(result);
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    // ── Data Retention ─────────────────────────────────────────────────────
    this.router.get('/retention', (req: Request, res: Response) => {
      try {
        const orgId = req.query.org_id as string | undefined;
        res.json({ policies: this.retention.listPolicies(orgId) });
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    this.router.patch('/retention/:id', (req: Request, res: Response) => {
      try {
        const { retention_days, enabled } = req.body;
        this.retention.updatePolicy(req.params.id, retention_days, enabled ?? true);

        this.auditLog.log({
          action: 'retention.update',
          resource_type: 'retention',
          resource_id: req.params.id,
          details: { retention_days, enabled },
          ip_address: req.ip,
        });

        res.json({ success: true });
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    this.router.post('/retention/purge', (req: Request, res: Response) => {
      try {
        const result = this.retention.runPurge();

        this.auditLog.log({
          action: 'retention.purge',
          resource_type: 'retention',
          details: result,
          ip_address: req.ip,
        });

        res.json(result);
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    // ── Usage Metering ─────────────────────────────────────────────────────
    this.router.get('/usage/:orgId', (req: Request, res: Response) => {
      try {
        res.json(this.usage.getQuotaDashboard(req.params.orgId));
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    this.router.get('/usage/:orgId/history', (req: Request, res: Response) => {
      try {
        const months = parseInt(req.query.months as string ?? '6', 10);
        res.json({ history: this.usage.getUsageHistory(req.params.orgId, months) });
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    // ── SLA Metrics ────────────────────────────────────────────────────────
    this.router.get('/sla', (req: Request, res: Response) => {
      try {
        const orgId = req.query.org_id as string | undefined;
        const hours = parseInt(req.query.hours as string ?? '24', 10);
        res.json(this.sla.getSummary(orgId, hours));
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });

    this.router.get('/sla/history', (req: Request, res: Response) => {
      try {
        const { org_id, endpoint, from, to, limit } = req.query as Record<string, string>;
        res.json({
          metrics: this.sla.getMetrics({
            org_id, endpoint, from, to,
            limit: limit ? parseInt(limit, 10) : undefined,
          }),
        });
      } catch (e: any) { res.status(500).json({ error: e.message }); }
    });
  }
}
