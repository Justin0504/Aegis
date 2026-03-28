/**
 * Admin audit log — immutable record of all administrative actions.
 *
 * Required for SOC 2, ISO 27001, HIPAA, FedRAMP compliance.
 * Every policy change, approval decision, key rotation, and config update is logged.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';

export type AuditAction =
  | 'policy.create' | 'policy.update' | 'policy.delete' | 'policy.toggle'
  | 'approval.approve' | 'approval.reject'
  | 'apikey.create' | 'apikey.revoke' | 'apikey.regenerate'
  | 'killswitch.revoke' | 'killswitch.restore'
  | 'user.create' | 'user.update' | 'user.delete' | 'user.invite'
  | 'org.create' | 'org.update' | 'org.settings'
  | 'retention.update' | 'retention.purge'
  | 'judge.batch' | 'judge.trace'
  | 'webhook.create' | 'webhook.delete'
  | 'data.export' | 'data.seed';

export type ResourceType =
  | 'policy' | 'approval' | 'apikey' | 'agent'
  | 'user' | 'organization' | 'retention'
  | 'judge' | 'webhook' | 'trace' | 'system';

export interface AuditEntry {
  org_id?: string;
  user_id?: string;
  user_email?: string;
  action: AuditAction;
  resource_type: ResourceType;
  resource_id?: string;
  details?: Record<string, any>;
  ip_address?: string;
}

export class AuditLogService {
  private insertStmt: Database.Statement;

  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {
    this.insertStmt = db.prepare(`
      INSERT INTO admin_audit_log (org_id, user_id, user_email, action, resource_type, resource_id, details, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  log(entry: AuditEntry): void {
    try {
      this.insertStmt.run(
        entry.org_id ?? null,
        entry.user_id ?? null,
        entry.user_email ?? null,
        entry.action,
        entry.resource_type,
        entry.resource_id ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
        entry.ip_address ?? null,
      );
      this.logger.info(
        { action: entry.action, resource: entry.resource_type, id: entry.resource_id },
        'Audit log entry',
      );
    } catch (err: any) {
      this.logger.error({ err, entry }, 'Failed to write audit log');
    }
  }

  query(opts: {
    org_id?: string;
    action?: string;
    resource_type?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  }): { entries: any[]; total: number } {
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (opts.org_id)        { where += ' AND org_id = ?';        params.push(opts.org_id); }
    if (opts.action)        { where += ' AND action = ?';        params.push(opts.action); }
    if (opts.resource_type) { where += ' AND resource_type = ?'; params.push(opts.resource_type); }
    if (opts.from)          { where += ' AND created_at >= ?';   params.push(opts.from); }
    if (opts.to)            { where += ' AND created_at <= ?';   params.push(opts.to); }

    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;

    const total = (this.db.prepare(
      `SELECT COUNT(*) as n FROM admin_audit_log ${where}`
    ).get(...params) as any).n;

    const entries = this.db.prepare(
      `SELECT * FROM admin_audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];

    return {
      entries: entries.map(e => ({
        ...e,
        details: e.details ? JSON.parse(e.details) : null,
      })),
      total,
    };
  }
}
