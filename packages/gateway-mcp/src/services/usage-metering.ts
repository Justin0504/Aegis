/**
 * Usage metering & quota enforcement — per-organization API usage tracking.
 *
 * Tracks: API calls, traces ingested, tokens consumed, cost, judge evaluations.
 * Enforces plan-based quotas and emits warnings at thresholds.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';

export interface PlanLimits {
  traces_per_month: number;
  api_calls_per_minute: number;
  agents: number;
  policies: number;
  users: number;
  judge_evals_per_month: number;
  retention_days: number;
}

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: {
    traces_per_month: 10_000,
    api_calls_per_minute: 60,
    agents: 5,
    policies: 10,
    users: 3,
    judge_evals_per_month: 100,
    retention_days: 30,
  },
  pro: {
    traces_per_month: 500_000,
    api_calls_per_minute: 500,
    agents: 50,
    policies: 100,
    users: 25,
    judge_evals_per_month: 5_000,
    retention_days: 90,
  },
  enterprise: {
    traces_per_month: Infinity,
    api_calls_per_minute: 5_000,
    agents: Infinity,
    policies: Infinity,
    users: Infinity,
    judge_evals_per_month: Infinity,
    retention_days: 365,
  },
};

export class UsageMeteringService {
  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {}

  /** Get current billing period (YYYY-MM). */
  private currentPeriod(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /** Increment a usage metric for an org. */
  increment(orgId: string, metric: string, amount: number = 1): void {
    const period = this.currentPeriod();
    this.db.prepare(`
      INSERT INTO usage_records (org_id, period, metric, value)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(org_id, period, metric)
      DO UPDATE SET value = value + ?, updated_at = datetime('now')
    `).run(orgId, period, metric, amount, amount);
  }

  /** Get current usage for an org in the current billing period. */
  getCurrentUsage(orgId: string): Record<string, number> {
    const period = this.currentPeriod();
    const rows = this.db.prepare(
      'SELECT metric, value FROM usage_records WHERE org_id = ? AND period = ?'
    ).all(orgId, period) as { metric: string; value: number }[];

    const usage: Record<string, number> = {};
    for (const r of rows) {
      usage[r.metric] = r.value;
    }
    return usage;
  }

  /** Get usage history for an org (last N months). */
  getUsageHistory(orgId: string, months: number = 6): any[] {
    const rows = this.db.prepare(`
      SELECT period, metric, value
      FROM usage_records
      WHERE org_id = ?
      ORDER BY period DESC
      LIMIT ?
    `).all(orgId, months * 10) as any[];

    // Group by period
    const byPeriod: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      if (!byPeriod[r.period]) byPeriod[r.period] = {};
      byPeriod[r.period][r.metric] = r.value;
    }

    return Object.entries(byPeriod)
      .map(([period, metrics]) => ({ period, ...metrics }))
      .sort((a, b) => b.period.localeCompare(a.period));
  }

  /** Check if org is within plan limits. Returns quota status. */
  checkQuota(orgId: string, metric: string): {
    allowed: boolean;
    current: number;
    limit: number;
    usage_pct: number;
    plan: string;
  } {
    const org = this.db.prepare('SELECT plan FROM organizations WHERE id = ?').get(orgId) as any;
    const plan = org?.plan ?? 'free';
    const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;

    const usage = this.getCurrentUsage(orgId);
    const current = usage[metric] ?? 0;
    const limit = (limits as any)[metric] ?? Infinity;

    return {
      allowed: current < limit,
      current,
      limit: limit === Infinity ? -1 : limit,
      usage_pct: limit === Infinity ? 0 : Math.round((current / limit) * 100),
      plan,
    };
  }

  /** Get full quota dashboard for an org. */
  getQuotaDashboard(orgId: string): {
    plan: string;
    period: string;
    quotas: Record<string, { current: number; limit: number; pct: number }>;
  } {
    const org = this.db.prepare('SELECT plan FROM organizations WHERE id = ?').get(orgId) as any;
    const plan = org?.plan ?? 'free';
    const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
    const usage = this.getCurrentUsage(orgId);

    const quotas: Record<string, { current: number; limit: number; pct: number }> = {};
    for (const [metric, limit] of Object.entries(limits)) {
      const current = usage[metric] ?? 0;
      quotas[metric] = {
        current,
        limit: limit === Infinity ? -1 : limit,
        pct: limit === Infinity ? 0 : Math.round((current / (limit as number)) * 100),
      };
    }

    return { plan, period: this.currentPeriod(), quotas };
  }
}
