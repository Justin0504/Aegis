/**
 * Data retention — configurable auto-purge for compliance (GDPR, CCPA, HIPAA).
 *
 * Runs on a configurable interval and deletes records older than the
 * retention period defined per resource type.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';

export interface RetentionPolicy {
  id: string;
  org_id: string | null;
  resource_type: string;
  retention_days: number;
  enabled: boolean;
  last_purge_at: string | null;
}

// Maps resource_type → { table, dateColumn }
const RESOURCE_MAP: Record<string, { table: string; dateCol: string }> = {
  traces:           { table: 'traces',           dateCol: 'created_at' },
  violations:       { table: 'violations',       dateCol: 'created_at' },
  admin_audit_log:  { table: 'admin_audit_log',  dateCol: 'created_at' },
  anomaly_events:   { table: 'anomaly_events',   dateCol: 'created_at' },
  anomaly_feedback: { table: 'anomaly_feedback',  dateCol: 'created_at' },
  judge_verdicts:   { table: 'judge_verdicts',   dateCol: 'judged_at'  },
  usage_records:    { table: 'usage_records',    dateCol: 'updated_at' },
  sla_metrics:      { table: 'sla_metrics',      dateCol: 'updated_at' },
};

export class RetentionService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {}

  /** Start the retention scheduler. */
  start(intervalMs: number = 3600_000): void {
    this.logger.info({ intervalMs }, 'Retention scheduler started');
    // Run once on start, then on interval
    this.runPurge();
    this.timer = setInterval(() => this.runPurge(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Execute purge for all enabled retention policies. */
  runPurge(): { purged: Record<string, number> } {
    const policies = this.db.prepare(
      'SELECT * FROM retention_policies WHERE enabled = 1'
    ).all() as RetentionPolicy[];

    const purged: Record<string, number> = {};

    for (const policy of policies) {
      const mapping = RESOURCE_MAP[policy.resource_type];
      if (!mapping) {
        this.logger.warn({ resource_type: policy.resource_type }, 'Unknown resource type in retention policy');
        continue;
      }

      try {
        let sql = `DELETE FROM ${mapping.table} WHERE ${mapping.dateCol} < datetime('now', '-${policy.retention_days} days')`;

        // Scope to org if policy is org-specific and table has org_id
        if (policy.org_id && ['traces'].includes(policy.resource_type)) {
          sql += ` AND org_id = '${policy.org_id}'`;
        }

        const result = this.db.prepare(sql).run();
        const count = result.changes;

        if (count > 0) {
          purged[policy.resource_type] = (purged[policy.resource_type] || 0) + count;
          this.logger.info(
            { resource: policy.resource_type, deleted: count, retention_days: policy.retention_days },
            'Retention purge executed',
          );
        }

        // Update last_purge_at
        this.db.prepare('UPDATE retention_policies SET last_purge_at = datetime("now") WHERE id = ?')
          .run(policy.id);
      } catch (err: any) {
        this.logger.error({ err, policy: policy.id }, 'Retention purge failed');
      }
    }

    return { purged };
  }

  // ── Policy CRUD ────────────────────────────────────────────────────────────

  listPolicies(orgId?: string): RetentionPolicy[] {
    if (orgId) {
      return this.db.prepare(
        'SELECT * FROM retention_policies WHERE org_id = ? OR org_id IS NULL ORDER BY resource_type'
      ).all(orgId) as RetentionPolicy[];
    }
    return this.db.prepare('SELECT * FROM retention_policies ORDER BY resource_type').all() as RetentionPolicy[];
  }

  updatePolicy(id: string, retentionDays: number, enabled: boolean): void {
    this.db.prepare(
      'UPDATE retention_policies SET retention_days = ?, enabled = ? WHERE id = ?'
    ).run(retentionDays, enabled ? 1 : 0, id);
  }

  createPolicy(orgId: string | null, resourceType: string, retentionDays: number): string {
    const { randomUUID } = require('crypto');
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO retention_policies (id, org_id, resource_type, retention_days) VALUES (?, ?, ?, ?)'
    ).run(id, orgId, resourceType, retentionDays);
    return id;
  }
}
