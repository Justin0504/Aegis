/**
 * Compliance EVIDENCE API — the auditor-facing endpoint that emits
 * structured payloads matching each Trust Service Criterion control.
 *
 *   GET /api/v1/compliance/evidence?type=<bundle>&since=<iso>&until=<iso>
 *   GET /api/v1/compliance/evidence/manifest
 *
 * One endpoint, many bundle types. Each bundle returns the JSON payload
 * a SOC 2 auditor (or a tool like Drata / Vanta) needs to verify a
 * specific Trust Service Criterion control — see
 * `compliance/soc2-mapping.md` in the repo root for the CC → `type` map.
 *
 * Design constraints:
 *
 *   1. Auth required (mounted under requireAuth in server.ts).
 *      Operator-level only; tenant admins cannot dump cross-tenant data.
 *   2. PII-safe by default — bundles redact email-local-parts. Auditors
 *      verify *control operation*, not customer content.
 *   3. Cardinality + size capped (limit ≤ 5000 rows). Larger windows
 *      use the offline export tool.
 *   4. Bundles never expose secrets (API keys, OIDC secrets, SP private
 *      keys). Every query whitelists columns explicitly.
 *
 * Sibling file `compliance.ts` handles the FRAMEWORK / CONTROL / BUNDLE
 * management surface (operator-defined attestation reports). This file
 * is the AUDITOR's read-only evidence tap.
 */

import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { z } from 'zod';
import type { GatewayMetricsService } from '../services/gateway-metrics';
import type { PolicyEngine } from '../policies/policy-engine';

const EvidenceQuerySchema = z.object({
  type: z.enum([
    'users', 'roles', 'audit-log', 'changes', 'incidents', 'vendors',
    'anomalies', 'monitoring', 'policies', 'sessions', 'access-review',
  ]),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  org_id: z.string().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});

const MAX_ROWS = 5000;

export class ComplianceEvidenceAPI {
  router: Router;

  constructor(
    private db: Database.Database,
    private logger: Logger,
    private gatewayMetrics?: GatewayMetricsService,
    private policyEngine?: PolicyEngine,
  ) {
    this.router = Router();
    this.registerRoutes();
  }

  private registerRoutes(): void {
    this.router.get('/evidence/manifest', this.manifest.bind(this));
    this.router.get('/evidence',          this.evidence.bind(this));
  }

  /** Inventory of supported bundle types. Auditors hit this once to
   *  enumerate the surface, then iterate per `type` for the window. */
  private manifest(_req: Request, res: Response): void {
    res.json({
      version: 1,
      bundle_types: [
        { type: 'users',          control: 'CC6.1/CC6.2', description: 'Cockpit users + roles + last login.' },
        { type: 'roles',          control: 'CC1.3',       description: 'Role-permissions snapshot.' },
        { type: 'audit-log',      control: 'CC6.3',       description: 'Audit trail of admin / state-changing actions.' },
        { type: 'changes',        control: 'CC8.1',       description: 'Schema + config changes (subset of audit-log).' },
        { type: 'incidents',      control: 'CC7.3-CC7.5', description: 'Security incidents.' },
        { type: 'vendors',        control: 'CC9.2',       description: 'Sub-processor list reference.' },
        { type: 'anomalies',      control: 'CC7.1',       description: 'Behavioural anomaly events.' },
        { type: 'monitoring',     control: 'CC7.2',       description: 'Live Prometheus snapshot.' },
        { type: 'policies',       control: 'CC5.2',       description: 'Effective policy set per tenant.' },
        { type: 'sessions',       control: 'CC6.1',       description: 'Active session stats.' },
        { type: 'access-review',  control: 'CC4.1',       description: 'Access-review attestation pointer.' },
      ],
      defaults: { limit: 1000, max_limit: MAX_ROWS },
    });
  }

  private async evidence(req: Request, res: Response): Promise<void> {
    const parsed = EvidenceQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', issues: parsed.error.issues });
      return;
    }
    const q = parsed.data;
    try {
      switch (q.type) {
        case 'users':         res.json(this.dumpUsers(q));                  return;
        case 'roles':         res.json(this.dumpRoles());                   return;
        case 'audit-log':     res.json(this.dumpAuditLog(q));               return;
        case 'changes':       res.json(this.dumpChanges(q));                return;
        case 'incidents':     res.json(this.dumpIncidents(q));              return;
        case 'vendors':       res.json(this.dumpVendors());                 return;
        case 'anomalies':     res.json(this.dumpAnomalies(q));              return;
        case 'monitoring':    res.json(this.dumpMonitoring());              return;
        case 'policies':      res.json(await this.dumpPolicies(q));         return;
        case 'sessions':      res.json(this.dumpSessions(q));               return;
        case 'access-review': res.json(this.dumpAccessReview());            return;
      }
    } catch (err: any) {
      this.logger.error({ err: err?.message, type: q.type }, 'compliance evidence query failed');
      res.status(500).json({ error: 'evidence query failed', detail: err?.message });
    }
  }

  // ── Bundle implementations ─────────────────────────────────────

  private dumpUsers(q: z.infer<typeof EvidenceQuerySchema>): any {
    if (!this.tableExists('users')) return { type: 'users', rows: [], note: 'users table not present' };
    const rows = q.org_id
      ? this.db.prepare(
          `SELECT id, org_id, email, role, last_login_at, created_at, status
           FROM users WHERE org_id = ? ORDER BY created_at DESC LIMIT ?`,
        ).all(q.org_id, q.limit) as any[]
      : this.db.prepare(
          `SELECT id, org_id, email, role, last_login_at, created_at, status
           FROM users ORDER BY created_at DESC LIMIT ?`,
        ).all(q.limit) as any[];
    return {
      type: 'users',
      window: { since: q.since, until: q.until },
      total: rows.length,
      rows: rows.map(r => ({ ...r, email: this.redactEmail(r.email) })),
    };
  }

  private dumpRoles(): any {
    return {
      type: 'roles',
      roles: [
        { role: 'admin',   description: 'Full cockpit access incl. policy + DSL + tenant config; can create users.' },
        { role: 'auditor', description: 'Read-only access incl. audit log + traces; cannot mutate.' },
        { role: 'viewer',  description: 'Cockpit dashboards only; no policy / config visibility.' },
      ],
    };
  }

  private dumpAuditLog(q: z.infer<typeof EvidenceQuerySchema>): any {
    if (!this.tableExists('audit_log')) return { type: 'audit-log', rows: [], note: 'audit_log table not present' };
    const conds: string[] = ['1=1'];
    const args: any[] = [];
    if (q.since)  { conds.push('timestamp >= ?'); args.push(q.since); }
    if (q.until)  { conds.push('timestamp <= ?'); args.push(q.until); }
    if (q.org_id) { conds.push('org_id = ?');     args.push(q.org_id); }
    const sql = `SELECT timestamp, org_id, actor, action, resource_type, resource_id, source_ip
                 FROM audit_log WHERE ${conds.join(' AND ')}
                 ORDER BY timestamp DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, q.limit) as any[];
    return { type: 'audit-log', window: { since: q.since, until: q.until }, total: rows.length, rows };
  }

  private dumpChanges(q: z.infer<typeof EvidenceQuerySchema>): any {
    if (!this.tableExists('audit_log')) return { type: 'changes', rows: [], note: 'audit_log table not present' };
    const conds: string[] = [
      '1=1',
      `(resource_type IN ('policy','config','dsl','tenant_config','sso','witness'))`,
    ];
    const args: any[] = [];
    if (q.since)  { conds.push('timestamp >= ?'); args.push(q.since); }
    if (q.until)  { conds.push('timestamp <= ?'); args.push(q.until); }
    if (q.org_id) { conds.push('org_id = ?');     args.push(q.org_id); }
    const sql = `SELECT timestamp, org_id, actor, action, resource_type, resource_id
                 FROM audit_log WHERE ${conds.join(' AND ')}
                 ORDER BY timestamp DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, q.limit) as any[];
    return { type: 'changes', window: { since: q.since, until: q.until }, total: rows.length, rows };
  }

  private dumpIncidents(_q: z.infer<typeof EvidenceQuerySchema>): any {
    return {
      type: 'incidents', total: 0, rows: [],
      note: 'incidents table not yet present — see compliance/policies/incident-response.md',
    };
  }

  private dumpVendors(): any {
    return {
      type: 'vendors',
      source: 'compliance/evidence/vendors.md',
      note: 'See compliance/policies/vendor-risk.md §6 — vendor list documented out-of-band.',
    };
  }

  private dumpAnomalies(q: z.infer<typeof EvidenceQuerySchema>): any {
    if (!this.tableExists('anomaly_events')) return { type: 'anomalies', rows: [], note: 'anomaly_events table not present' };
    const conds: string[] = ['1=1'];
    const args: any[] = [];
    if (q.since)  { conds.push('created_at >= ?'); args.push(q.since); }
    if (q.until)  { conds.push('created_at <= ?'); args.push(q.until); }
    const sql = `SELECT created_at, agent_id, score, decision, signal_count
                 FROM anomaly_events WHERE ${conds.join(' AND ')}
                 ORDER BY created_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, q.limit) as any[];
    return { type: 'anomalies', window: { since: q.since, until: q.until }, total: rows.length, rows };
  }

  private dumpMonitoring(): any {
    if (!this.gatewayMetrics) return { type: 'monitoring', note: 'gateway metrics not wired' };
    return { type: 'monitoring', snapshot: this.gatewayMetrics.snapshot() };
  }

  private async dumpPolicies(q: z.infer<typeof EvidenceQuerySchema>): Promise<any> {
    if (!this.policyEngine) return { type: 'policies', note: 'policy engine not wired' };
    const orgId = q.org_id ?? 'default';
    const list = await this.policyEngine.getAllPolicies(orgId);
    return {
      type: 'policies',
      org_id: orgId,
      total: list.length,
      rows: list.map(p => ({
        id: p.id, name: p.name, risk_level: p.risk_level, enabled: p.enabled,
        org_id: p.org_id, scope: p.org_id === '*' ? 'platform-default' : 'tenant-override',
      })),
    };
  }

  private dumpSessions(_q: z.infer<typeof EvidenceQuerySchema>): any {
    if (!this.tableExists('sessions')) return { type: 'sessions', note: 'sessions table not present' };
    const row = this.db.prepare(
      `SELECT COUNT(*) AS active_total,
              AVG((CAST(strftime('%s', expires_at) AS INTEGER) - CAST(strftime('%s', created_at) AS INTEGER))) AS avg_lifetime_seconds
       FROM sessions WHERE datetime(expires_at) > datetime('now')`,
    ).get() as any;
    return {
      type: 'sessions',
      active_total: row?.active_total ?? 0,
      avg_lifetime_seconds: row?.avg_lifetime_seconds ?? 0,
    };
  }

  private dumpAccessReview(): any {
    return {
      type: 'access-review',
      note: 'Access-review attestations live in compliance/evidence/access-review-YYYYMMDD/ on the operator-side. See compliance/runbooks/access-review.md.',
    };
  }

  // ── Helpers ────────────────────────────────────────────────────

  private tableExists(name: string): boolean {
    const row = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) as any;
    return !!row;
  }

  private redactEmail(email: string | null | undefined): string | null {
    if (!email) return null;
    const [_local, domain] = email.split('@');
    return domain ? `***@${domain}` : '***';
  }
}
