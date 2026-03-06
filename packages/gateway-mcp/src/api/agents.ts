import { Router } from 'express';
import Database from 'better-sqlite3';
import { Logger } from 'pino';

export class AgentsAPI {
  router: Router;

  constructor(private db: Database.Database, private logger: Logger) {
    this.router = Router();
    this.registerRoutes();
  }

  private registerRoutes() {
    // GET /api/v1/agents/:agentId/baseline
    this.router.get('/:agentId/baseline', (req, res) => {
      try {
        const { agentId } = req.params;
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        // Total traces in last 7 days
        const total = (this.db.prepare(
          `SELECT COUNT(*) as n FROM traces WHERE agent_id = ? AND timestamp > ?`
        ).get(agentId, since) as any).n as number;

        if (total === 0) {
          return res.json({ agentId, total: 0, top_tools: [], risk_distribution: {}, sessions: 0, pii_rate: 0, block_rate: 0 });
        }

        // Top tools (tool_call field uses 'tool_name' key)
        const top_tools = this.db.prepare(`
          SELECT tool_name, COUNT(*) as count
          FROM (
            SELECT COALESCE(
              json_extract(tool_call, '$.tool_name'),
              json_extract(tool_call, '$.name'),
              json_extract(tool_call, '$.function')
            ) as tool_name
            FROM traces WHERE agent_id = ? AND timestamp > ?
          )
          WHERE tool_name IS NOT NULL
          GROUP BY tool_name ORDER BY count DESC LIMIT 8
        `).all(agentId, since) as { tool_name: string; count: number }[];

        // Risk distribution
        const riskRows = this.db.prepare(`
          SELECT
            SUM(CASE WHEN json_extract(safety_validation, '$.risk_level') = 'LOW'      THEN 1 ELSE 0 END) as low,
            SUM(CASE WHEN json_extract(safety_validation, '$.risk_level') = 'MEDIUM'   THEN 1 ELSE 0 END) as medium,
            SUM(CASE WHEN json_extract(safety_validation, '$.risk_level') = 'HIGH'     THEN 1 ELSE 0 END) as high,
            SUM(CASE WHEN json_extract(safety_validation, '$.risk_level') = 'CRITICAL' THEN 1 ELSE 0 END) as critical
          FROM traces WHERE agent_id = ? AND timestamp > ?
        `).get(agentId, since) as any;

        // Sessions
        let sessions = 0;
        try {
          sessions = (this.db.prepare(
            `SELECT COUNT(DISTINCT session_id) as n FROM traces WHERE agent_id = ? AND timestamp > ? AND session_id IS NOT NULL`
          ).get(agentId, since) as any).n;
        } catch {}

        // PII rate
        let pii_count = 0;
        try {
          pii_count = (this.db.prepare(
            `SELECT COUNT(*) as n FROM traces WHERE agent_id = ? AND timestamp > ? AND pii_detected = 1`
          ).get(agentId, since) as any).n;
        } catch {}

        // Block rate
        let block_count = 0;
        try {
          block_count = (this.db.prepare(
            `SELECT COUNT(*) as n FROM traces WHERE agent_id = ? AND timestamp > ? AND blocked = 1`
          ).get(agentId, since) as any).n;
        } catch {}

        res.json({
          agentId,
          total,
          top_tools,
          risk_distribution: {
            LOW:      riskRows?.low      ?? 0,
            MEDIUM:   riskRows?.medium   ?? 0,
            HIGH:     riskRows?.high     ?? 0,
            CRITICAL: riskRows?.critical ?? 0,
          },
          sessions,
          pii_rate:   total > 0 ? Math.round((pii_count   / total) * 100) : 0,
          block_rate: total > 0 ? Math.round((block_count / total) * 100) : 0,
          window_days: 7,
        });
      } catch (err) {
        this.logger.error({ err }, 'Failed to compute agent baseline');
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  }
}
