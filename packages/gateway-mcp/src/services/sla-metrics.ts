/**
 * SLA metrics — latency percentile tracking and availability monitoring.
 *
 * Collects request latency samples in-memory, periodically flushes
 * P50/P95/P99 to the database for historical reporting and SLA compliance.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';

interface LatencySample {
  endpoint: string;
  latency_ms: number;
  success: boolean;
  org_id: string;
}

export class SLAMetricsService {
  private buffer: LatencySample[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {}

  /** Record a request latency sample. */
  record(endpoint: string, latencyMs: number, success: boolean, orgId: string = 'default'): void {
    this.buffer.push({ endpoint, latency_ms: latencyMs, success, org_id: orgId });
  }

  /** Start periodic flush (default every 60s). */
  start(intervalMs: number = 60_000): void {
    this.timer = setInterval(() => this.flush(), intervalMs);
    this.logger.info({ intervalMs }, 'SLA metrics collection started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.flush(); // Final flush
      this.timer = null;
    }
  }

  /** Flush buffered samples to database as aggregated percentiles. */
  flush(): void {
    if (this.buffer.length === 0) return;

    const samples = this.buffer.splice(0);
    const period = new Date().toISOString().substring(0, 16); // YYYY-MM-DDTHH:MM

    // Group by org_id + endpoint
    const groups = new Map<string, LatencySample[]>();
    for (const s of samples) {
      const key = `${s.org_id}||${s.endpoint}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }

    const upsert = this.db.prepare(`
      INSERT INTO sla_metrics (org_id, period, endpoint, request_count, error_count, p50_ms, p95_ms, p99_ms, avg_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id, period, endpoint)
      DO UPDATE SET
        request_count = request_count + ?,
        error_count = error_count + ?,
        p50_ms = ?, p95_ms = ?, p99_ms = ?, avg_ms = ?,
        updated_at = datetime('now')
    `);

    for (const [key, group] of groups) {
      const [orgId, endpoint] = key.split('||');
      const latencies = group.map(s => s.latency_ms).sort((a, b) => a - b);
      const errors = group.filter(s => !s.success).length;
      const count = group.length;

      const p50 = percentile(latencies, 50);
      const p95 = percentile(latencies, 95);
      const p99 = percentile(latencies, 99);
      const avg = latencies.reduce((s, v) => s + v, 0) / count;

      upsert.run(
        orgId, period, endpoint, count, errors, p50, p95, p99, avg,
        count, errors, p50, p95, p99, avg,
      );
    }

    this.logger.debug({ samples: samples.length, groups: groups.size }, 'SLA metrics flushed');
  }

  /** Get SLA metrics for a time range. */
  getMetrics(opts: {
    org_id?: string;
    endpoint?: string;
    from?: string;
    to?: string;
    limit?: number;
  } = {}): any[] {
    let where = 'WHERE 1=1';
    const params: any[] = [];

    if (opts.org_id)   { where += ' AND org_id = ?';   params.push(opts.org_id); }
    if (opts.endpoint) { where += ' AND endpoint = ?'; params.push(opts.endpoint); }
    if (opts.from)     { where += ' AND period >= ?';   params.push(opts.from); }
    if (opts.to)       { where += ' AND period <= ?';   params.push(opts.to); }

    return this.db.prepare(
      `SELECT * FROM sla_metrics ${where} ORDER BY period DESC LIMIT ?`
    ).all(...params, opts.limit ?? 100);
  }

  /** Get aggregated SLA summary (uptime %, avg latency, p95). */
  getSummary(orgId?: string, hours: number = 24): any {
    const from = new Date(Date.now() - hours * 3600_000).toISOString().substring(0, 16);
    let where = 'WHERE period >= ?';
    const params: any[] = [from];

    if (orgId) { where += ' AND org_id = ?'; params.push(orgId); }

    const row = this.db.prepare(`
      SELECT
        SUM(request_count) as total_requests,
        SUM(error_count) as total_errors,
        AVG(p50_ms) as avg_p50,
        AVG(p95_ms) as avg_p95,
        AVG(p99_ms) as avg_p99,
        AVG(avg_ms) as avg_latency
      FROM sla_metrics ${where}
    `).get(...params) as any;

    const totalReqs = row?.total_requests ?? 0;
    const totalErrors = row?.total_errors ?? 0;
    const uptime = totalReqs > 0
      ? Math.round(((totalReqs - totalErrors) / totalReqs) * 10000) / 100
      : 100;

    return {
      period_hours: hours,
      total_requests: totalReqs,
      total_errors: totalErrors,
      uptime_pct: uptime,
      latency: {
        p50: Math.round(row?.avg_p50 ?? 0),
        p95: Math.round(row?.avg_p95 ?? 0),
        p99: Math.round(row?.avg_p99 ?? 0),
        avg: Math.round(row?.avg_latency ?? 0),
      },
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}
