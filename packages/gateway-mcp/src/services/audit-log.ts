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
  | 'data.export' | 'data.seed'
  | 'tenant.config.update' | 'tenant.config.replace' | 'tenant.config.apply-template'
  | 'proxy.llm_call'
  | 'admin.bulk_register'
  | 'rollback.compensate' | 'rollback.chain' | 'rollback.delegation'
  | 'outbox.enqueue' | 'outbox.cancel' | 'outbox.fire'
  | 'predeploy.scan'
  | 'policy.pack_install';

export type ResourceType =
  | 'policy' | 'approval' | 'apikey' | 'agent'
  | 'user' | 'organization' | 'retention'
  | 'judge' | 'webhook' | 'trace' | 'system'
  | 'delegation';

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

export type AuditSubscriber = (entry: AuditEntry & { timestamp: string }) => void;

export class AuditLogService {
  private insertStmt: Database.Statement;
  private subscribers: AuditSubscriber[] = [];

  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {
    this.insertStmt = db.prepare(`
      INSERT INTO admin_audit_log (org_id, user_id, user_email, action, resource_type, resource_id, details, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /**
   * Register a callback fired AFTER every successful audit row write.
   * Subscriber errors are isolated — they never affect persistence or
   * other subscribers. Used by SinkRuntime to fan audit events out to
   * customer-supplied SIEM destinations.
   */
  subscribe(fn: AuditSubscriber): () => void {
    this.subscribers.push(fn);
    return () => {
      this.subscribers = this.subscribers.filter(s => s !== fn);
    };
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
      const stamped = { ...entry, timestamp: new Date().toISOString() };
      for (const fn of this.subscribers) {
        try { fn(stamped); }
        catch (err) {
          this.logger.warn(
            { err: (err as Error).message },
            'audit subscriber failed (isolated)',
          );
        }
      }
    } catch (err: any) {
      this.logger.error({ err, entry }, 'Failed to write audit log');
    }
  }

  query(opts: {
    org_id?: string;
    action?: string;
    resource_type?: string;
    resource_id?: string;
    /** Substring search across action / resource_id / details. */
    q?: string;
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
    if (opts.resource_id)   { where += ' AND resource_id = ?';   params.push(opts.resource_id); }
    if (opts.from)          { where += ' AND created_at >= ?';   params.push(opts.from); }
    if (opts.to)            { where += ' AND created_at <= ?';   params.push(opts.to); }
    if (opts.q && opts.q.trim()) {
      // Substring match across the three columns most relevant to an
      // ops query: the action, the resource id, and the JSON details
      // blob. Parameter is bound once, used three times.
      where += ' AND (action LIKE ? OR resource_id LIKE ? OR details LIKE ?)';
      const needle = `%${opts.q.trim()}%`;
      params.push(needle, needle, needle);
    }

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
