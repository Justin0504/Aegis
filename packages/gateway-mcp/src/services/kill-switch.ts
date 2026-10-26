import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { SafetyValidation } from '@agentguard/core-schema';
import { config } from '../config';

export class KillSwitchService {
  private violationCounts = new Map<string, { count: number; firstViolation: number }>();

  constructor(
    private db: Database.Database,
    private logger: Logger
  ) {
    // Clean up expired violations periodically
    setInterval(() => this.cleanupExpiredViolations(), 60 * 1000).unref?.(); // Every minute; never keeps a process alive
  }

  async recordViolation(agentId: string, validation: SafetyValidation) {
    // Record in database
    const stmt = this.db.prepare(`
      INSERT INTO violations (agent_id, policy_id, trace_id, violation_type, details)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      agentId,
      validation.policy_name,
      '', // trace_id would be passed in production
      validation.risk_level,
      JSON.stringify(validation.violations)
    );

    // Update in-memory counter
    const now = Date.now();
    const existing = this.violationCounts.get(agentId);

    if (!existing) {
      this.violationCounts.set(agentId, { count: 1, firstViolation: now });
    } else {
      const windowStart = now - (config.killSwitch.violationWindow * 1000);

      if (existing.firstViolation < windowStart) {
        // Reset counter if outside window
        this.violationCounts.set(agentId, { count: 1, firstViolation: now });
      } else {
        // Increment counter
        existing.count++;

        // Check if we should trigger kill switch
        if (existing.count >= config.killSwitch.maxViolations) {
          await this.revokeAgentAccess(agentId, 'Exceeded maximum policy violations');
        }
      }
    }

    this.logger.warn(
      {
        agentId,
        policy: validation.policy_name,
        violationCount: this.violationCounts.get(agentId)?.count,
        riskLevel: validation.risk_level
      },
      'Policy violation recorded'
    );
  }

  /** Count a call the gateway refused, without writing a violations row
   *  (/check writes its own); trips the switch at the configured count. */
  async countBlock(agentId: string) {
    const now = Date.now();
    const windowStart = now - (config.killSwitch.violationWindow * 1000);
    const existing = this.violationCounts.get(agentId);
    if (!existing || existing.firstViolation < windowStart) {
      this.violationCounts.set(agentId, { count: 1, firstViolation: now });
      return;
    }
    existing.count++;
    if (existing.count >= config.killSwitch.maxViolations) {
      await this.revokeAgentAccess(agentId, 'Exceeded maximum policy violations');
    }
  }

  async revokeAgentAccess(agentId: string, reason: string) {
    const stmt = this.db.prepare(`
      UPDATE api_keys
      SET status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP, revocation_reason = ?
      WHERE agent_id = ? AND status = 'ACTIVE'
    `);

    // An SDK agent is identified by its id, not by a per-agent api_keys
    // row, so revoking only api_keys left most agents untouched while the
    // API reported success. Suspending the registry row is what /check,
    // the egress proxy and the MCP proxy all refuse.
    let suspended = 0;
    try {
      suspended = this.db.prepare(
        `UPDATE agents SET status = 'suspended', updated_at = datetime('now') WHERE id = ? AND status != 'suspended'`,
      ).run(agentId).changes;
    } catch { /* agents table absent in minimal test databases */ }

    const result = stmt.run(reason, agentId);

    if (result.changes > 0 || suspended > 0) {
      this.logger.error(
        { agentId, reason },
        'KILL SWITCH ACTIVATED: Agent access revoked'
      );

      // Clear violation counter
      this.violationCounts.delete(agentId);

      // In production, would also:
      // - Notify security team
      // - Terminate active connections
      // - Log to audit system
    }
  }

  async isAgentBlocked(agentId: string): Promise<boolean> {
    const stmt = this.db.prepare(`
      SELECT status FROM api_keys
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const result = stmt.get(agentId) as any;
    return result?.status === 'REVOKED';
  }

  async getViolationHistory(
    agentId: string,
    limit: number = 100
  ): Promise<any[]> {
    const stmt = this.db.prepare(`
      SELECT v.*, p.name as policy_name, p.risk_level
      FROM violations v
      JOIN policies p ON v.policy_id = p.id
      WHERE v.agent_id = ?
      ORDER BY v.created_at DESC
      LIMIT ?
    `);

    return stmt.all(agentId, limit);
  }

  async reinstateAgent(agentId: string) {
    // Create new API key for agent
    const stmt = this.db.prepare(`
      INSERT INTO api_keys (agent_id, key_hash, status)
      VALUES (?, ?, 'ACTIVE')
    `);

    const { createHash, randomBytes } = require('crypto');
    const keyHash = createHash('sha256').update(randomBytes(32)).digest('hex');
    stmt.run(agentId, keyHash);

    // Clear violation history
    this.violationCounts.delete(agentId);

    this.logger.info({ agentId }, 'Agent access reinstated');
  }

  private cleanupExpiredViolations() {
    const now = Date.now();
    const windowStart = now - (config.killSwitch.violationWindow * 1000);

    for (const [agentId, data] of this.violationCounts.entries()) {
      if (data.firstViolation < windowStart) {
        this.violationCounts.delete(agentId);
      }
    }
  }

  getAgentStatus(agentId: string): {
    blocked: boolean;
    violationCount: number;
    windowRemaining: number;
  } {
    const violations = this.violationCounts.get(agentId);
    const row = this.db.prepare(`SELECT status FROM api_keys WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1`).get(agentId) as any;
    const blocked = row?.status === 'REVOKED';

    if (!violations) {
      return {
        blocked: false,
        violationCount: 0,
        windowRemaining: 0,
      };
    }

    const now = Date.now();
    const windowEnd = violations.firstViolation + (config.killSwitch.violationWindow * 1000);
    const windowRemaining = Math.max(0, windowEnd - now);

    return {
      blocked,
      violationCount: violations.count,
      windowRemaining: Math.floor(windowRemaining / 1000), // seconds
    };
  }
}