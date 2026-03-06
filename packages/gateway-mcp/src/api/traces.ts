import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { z } from 'zod';
import {
  AgentActionTraceSchema,
  TraceQuerySchema,
  TraceBundleSchema,
  validateTraceChain,
} from '@agentguard/core-schema';
import { calculateCost } from '../services/cost';
import { redactObjectPii } from '../services/pii';
import { emitTraceSpan } from '../services/otel';

export class TraceAPI {
  public readonly router: Router;

  constructor(
    private db: Database.Database,
    private logger: Logger
  ) {
    this.router = Router();
    this.setupRoutes();
  }

  private setupRoutes() {
    // Create single trace
    this.router.post('/', async (req: Request, res: Response) => {
      try {
        const trace = AgentActionTraceSchema.parse(req.body);

        // Verify hash chain (soft validation — log but don't reject)
        const previousTrace = this.getPreviousTrace(trace.agent_id as string);
        if (previousTrace && trace.previous_hash && trace.previous_hash !== previousTrace.integrity_hash) {
          this.logger.warn({
            expected: previousTrace.integrity_hash,
            received: trace.previous_hash,
          }, 'Hash chain gap detected');
        }

        await this.storeTrace(trace, req.body);
        res.status(201).json({ trace_id: trace.trace_id });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ error: 'Invalid trace format', details: error.errors });
        }
        this.logger.error({ error }, 'Failed to create trace');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Batch create traces
    this.router.post('/batch', async (req: Request, res: Response) => {
      try {
        const { traces } = req.body;
        if (!Array.isArray(traces)) {
          return res.status(400).json({ error: 'traces must be an array' });
        }
        const validTraces = traces.map((t, i) => ({ parsed: AgentActionTraceSchema.parse(t), raw: t }));
        const transaction = this.db.transaction((rows: any[]) => {
          for (const { parsed, raw } of rows) this.insertTrace(parsed, raw);
        });
        transaction(validTraces);
        res.status(201).json({ created: validTraces.length, trace_ids: validTraces.map(({ parsed }) => parsed.trace_id) });
      } catch (error) {
        this.logger.error({ error }, 'Failed to create batch traces');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Query traces
    this.router.get('/', async (req: Request, res: Response) => {
      try {
        const query = TraceQuerySchema.parse(req.query);

        let baseSql = 'FROM traces WHERE 1=1';
        const params: any[] = [];

        if (query.agent_id) { baseSql += ' AND agent_id = ?'; params.push(query.agent_id); }
        if (query.start_time) { baseSql += ' AND timestamp >= ?'; params.push(query.start_time); }
        if (query.end_time) { baseSql += ' AND timestamp <= ?'; params.push(query.end_time); }
        if (query.risk_level) {
          baseSql += " AND json_extract(safety_validation, '$.risk_level') = ?";
          params.push(query.risk_level);
        }
        if (query.approval_status) { baseSql += ' AND approval_status = ?'; params.push(query.approval_status); }

        const total = (this.db.prepare(`SELECT COUNT(*) as n ${baseSql}`).get(...params) as any).n as number;

        const sql = `SELECT * ${baseSql} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
        const traces = this.db.prepare(sql).all(...params, query.limit, query.offset) as any[];
        res.json({ traces: traces.map(this.parseTrace), total, limit: query.limit, offset: query.offset });
      } catch (error) {
        this.logger.error({ error }, 'Failed to query traces');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Update trace (approval + score)  [defined before GET /:traceId intentionally]
    this.router.patch('/:traceId', async (req: Request, res: Response) => {
      try {
        const { approval_status, approved_by, score, score_label, feedback, scored_by } = req.body;
        const updates: string[] = [];
        const values: any[] = [];

        if (approval_status !== undefined) {
          if (!['APPROVED', 'REJECTED', 'PENDING'].includes(approval_status)) {
            return res.status(400).json({ error: 'Invalid approval_status' });
          }
          updates.push('approval_status = ?', 'approved_by = ?');
          values.push(approval_status, approved_by || 'human-reviewer');
        }

        if (score !== undefined) {
          updates.push('score = ?', 'score_label = ?', 'feedback = ?', 'scored_by = ?', "scored_at = datetime('now')");
          values.push(score, score_label ?? (score > 0 ? 'good' : 'bad'), feedback ?? null, scored_by ?? 'dashboard-user');
        }

        if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

        values.push(req.params.traceId);
        const result = this.db.prepare(
          `UPDATE traces SET ${updates.join(', ')} WHERE trace_id = ?`
        ).run(...values);

        if (result.changes === 0) return res.status(404).json({ error: 'Trace not found' });
        res.json({ trace_id: req.params.traceId, updated: true });
      } catch (error) {
        this.logger.error({ error }, 'Failed to update trace');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Cost summary endpoint
    this.router.get('/stats/cost', async (req: Request, res: Response) => {
      try {
        const { agent_id, since } = req.query as Record<string, string>;
        let sql = `SELECT
          agent_id,
          model,
          COUNT(*) as trace_count,
          SUM(input_tokens) as total_input_tokens,
          SUM(output_tokens) as total_output_tokens,
          SUM(cost_usd) as total_cost_usd
        FROM traces WHERE 1=1`;
        const params: any[] = [];
        if (agent_id) { sql += ' AND agent_id = ?'; params.push(agent_id); }
        if (since)    { sql += ' AND timestamp >= ?'; params.push(since); }
        sql += ' GROUP BY agent_id, model ORDER BY total_cost_usd DESC';
        const rows = this.db.prepare(sql).all(...params);

        const overall = this.db.prepare(
          `SELECT SUM(cost_usd) as total, SUM(input_tokens) as inp, SUM(output_tokens) as out
           FROM traces WHERE cost_usd > 0 ${agent_id ? 'AND agent_id = ?' : ''}`
        ).get(...(agent_id ? [agent_id] : [])) as any;

        res.json({ by_agent_model: rows, total_cost_usd: overall?.total ?? 0,
          total_input_tokens: overall?.inp ?? 0, total_output_tokens: overall?.out ?? 0 });
      } catch (error) {
        this.logger.error({ error }, 'Cost stats error');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Sessions list endpoint
    this.router.get('/sessions', async (req: Request, res: Response) => {
      try {
        const { agent_id, since, limit = '50' } = req.query as Record<string, string>;
        const params: any[] = [];
        let where = "WHERE session_id IS NOT NULL AND session_id != ''";
        if (agent_id) { where += ' AND agent_id = ?'; params.push(agent_id); }
        if (since)    { where += ' AND timestamp >= ?'; params.push(since); }

        const sessions = this.db.prepare(`
          SELECT
            session_id,
            agent_id,
            COUNT(*) as trace_count,
            MIN(timestamp) as started_at,
            MAX(timestamp) as last_seen_at,
            SUM(cost_usd) as total_cost_usd,
            SUM(input_tokens + output_tokens) as total_tokens,
            SUM(CASE WHEN json_extract(observation, '$.error') IS NOT NULL THEN 1 ELSE 0 END) as error_count
          FROM traces ${where}
          GROUP BY session_id, agent_id
          ORDER BY last_seen_at DESC
          LIMIT ?
        `).all(...params, Number(limit)) as any[];

        res.json({ sessions, total: sessions.length });
      } catch (error) {
        this.logger.error({ error }, 'Sessions list error');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Evaluation/scoring stats endpoint
    this.router.get('/stats/eval', async (req: Request, res: Response) => {
      try {
        const { agent_id, since } = req.query as Record<string, string>;
        const params: any[] = [];
        let where = 'WHERE score IS NOT NULL';
        if (agent_id) { where += ' AND agent_id = ?'; params.push(agent_id); }
        if (since)    { where += ' AND timestamp >= ?'; params.push(since); }

        const overall = this.db.prepare(`
          SELECT
            COUNT(*) as scored_count,
            SUM(CASE WHEN score > 0 THEN 1 ELSE 0 END) as thumbs_up,
            SUM(CASE WHEN score < 0 THEN 1 ELSE 0 END) as thumbs_down,
            AVG(score) as avg_score
          FROM traces ${where}
        `).get(...params) as any;

        const byAgent = this.db.prepare(`
          SELECT
            agent_id,
            COUNT(*) as scored,
            SUM(CASE WHEN score > 0 THEN 1 ELSE 0 END) as good,
            SUM(CASE WHEN score < 0 THEN 1 ELSE 0 END) as bad
          FROM traces ${where}
          GROUP BY agent_id ORDER BY good DESC
        `).all(...params);

        const recent = this.db.prepare(`
          SELECT trace_id, agent_id, tool_call, score, score_label, feedback, scored_at
          FROM traces ${where}
          ORDER BY scored_at DESC LIMIT 20
        `).all(...params) as any[];

        res.json({
          scored_count: overall?.scored_count ?? 0,
          thumbs_up:    overall?.thumbs_up    ?? 0,
          thumbs_down:  overall?.thumbs_down  ?? 0,
          avg_score:    overall?.avg_score    ?? 0,
          by_agent:     byAgent,
          recent_scored: recent.map(r => ({
            ...r,
            tool_call: r.tool_call ? JSON.parse(r.tool_call) : null,
          })),
        });
      } catch (error) {
        this.logger.error({ error }, 'Eval stats error');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get single trace  [must be after all /stats/* and /sessions routes]
    this.router.get('/:traceId', async (req: Request, res: Response) => {
      try {
        const trace = this.db.prepare('SELECT * FROM traces WHERE trace_id = ?').get(req.params.traceId) as any;
        if (!trace) return res.status(404).json({ error: 'Trace not found' });
        res.json(this.parseTrace(trace));
      } catch (error) {
        this.logger.error({ error }, 'Failed to get trace');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Export traces as forensic bundle
    this.router.post('/export', async (req: Request, res: Response) => {
      try {
        const { agent_id, start_time, end_time, reason } = req.body;
        let sql = 'SELECT * FROM traces WHERE agent_id = ?';
        const params: any[] = [agent_id];
        if (start_time) { sql += ' AND timestamp >= ?'; params.push(start_time); }
        if (end_time)   { sql += ' AND timestamp <= ?'; params.push(end_time); }
        sql += ' ORDER BY sequence_number ASC';

        const traces = (this.db.prepare(sql).all(...params) as any[]).map(this.parseTrace);
        const bundle = TraceBundleSchema.parse({
          traces,
          metadata: {
            agent_id,
            session_id: req.body.session_id || 'unknown',
            export_reason: reason || 'Manual export',
            total_traces: traces.length,
            hash_chain_valid: validateTraceChain(traces),
          },
        });
        res.json(bundle);
      } catch (error) {
        this.logger.error({ error }, 'Failed to export traces');
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private safeJsonParse(json: string | null | undefined, fallback: any = null): any {
    if (json == null) return fallback;
    try { return JSON.parse(json); } catch { return fallback; }
  }

  private parseTrace = (t: any) => ({
    ...t,
    input_context:     this.safeJsonParse(t.input_context, {}),
    thought_chain:     this.safeJsonParse(t.thought_chain, { raw_tokens: '' }),
    tool_call:         this.safeJsonParse(t.tool_call, {}),
    observation:       this.safeJsonParse(t.observation, {}),
    safety_validation: this.safeJsonParse(t.safety_validation, null),
    tags:              this.safeJsonParse(t.tags, null),
  });

  private extractTokenUsage(raw: any): { model: string | null; inputTokens: number; outputTokens: number } {
    // SDK embeds token data in observation.metadata.token_usage
    let meta: any = {};
    try {
      const obs = typeof raw.observation === 'string' ? JSON.parse(raw.observation) : raw.observation;
      meta = obs?.metadata?.token_usage ?? obs?.metadata ?? {};
    } catch { /* */ }

    const model = meta.model ?? raw.model ?? null;
    const inputTokens  = Number(meta.input_tokens  ?? meta.prompt_tokens    ?? 0);
    const outputTokens = Number(meta.output_tokens ?? meta.completion_tokens ?? 0);
    return { model, inputTokens, outputTokens };
  }

  private async storeTrace(trace: any, raw: any) {
    this.insertTrace(trace, raw);
  }

  private insertTrace(trace: any, raw: any) {
    const { model, inputTokens, outputTokens } = this.extractTokenUsage(raw);
    const costUsd = (model && (inputTokens || outputTokens))
      ? calculateCost(model, inputTokens, outputTokens)
      : 0;

    const sessionId = raw.session_id ?? raw.metadata?.session_id ?? null;

    // PII redaction on mutable trace fields
    const { redacted: redactedInput,  count: c1 } = redactObjectPii(trace.input_context);
    const { redacted: redactedThought, count: c2 } = redactObjectPii(trace.thought_chain);
    const { redacted: redactedTool,   count: c3 } = redactObjectPii(trace.tool_call);
    const { redacted: redactedObs,    count: c4 } = redactObjectPii(trace.observation);
    const piiDetected = c1 + c2 + c3 + c4;

    if (piiDetected > 0) {
      this.logger.warn({ trace_id: String(trace.trace_id), pii_count: piiDetected }, 'PII redacted from trace');
    }

    this.db.prepare(`
      INSERT INTO traces (
        trace_id, parent_trace_id, agent_id, timestamp, sequence_number,
        input_context, thought_chain, tool_call, observation,
        integrity_hash, previous_hash, signature,
        safety_validation, approval_status, approved_by,
        environment, version, tags,
        model, input_tokens, output_tokens, cost_usd,
        session_id, pii_detected
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?
      )
    `).run(
      String(trace.trace_id),
      trace.parent_trace_id ? String(trace.parent_trace_id) : null,
      String(trace.agent_id),
      trace.timestamp instanceof Date ? trace.timestamp.toISOString() : String(trace.timestamp),
      Number(trace.sequence_number),
      JSON.stringify(redactedInput),
      JSON.stringify(redactedThought),
      JSON.stringify(redactedTool),
      JSON.stringify(redactedObs),
      String(trace.integrity_hash),
      trace.previous_hash ? String(trace.previous_hash) : null,
      trace.signature ? String(trace.signature) : null,
      JSON.stringify(trace.safety_validation ?? null),
      trace.approval_status ? String(trace.approval_status) : null,
      trace.approved_by ? String(trace.approved_by) : null,
      String(trace.environment ?? 'DEVELOPMENT'),
      String(trace.version ?? '1.0.0'),
      JSON.stringify(trace.tags ?? null),
      model,
      inputTokens,
      outputTokens,
      costUsd,
      sessionId,
      piiDetected,
    );

    // Emit OTEL span async, non-blocking
    const toolName = trace.tool_call?.tool_name ?? trace.tool_call?.function ?? 'unknown';
    const riskLevel = trace.safety_validation?.risk_level ?? 'LOW';
    const blocked = trace.safety_validation?.passed === false;
    const durationMs = raw.observation?.duration_ms ?? 0;
    const errorMsg = raw.observation?.error ?? null;
    setImmediate(() => emitTraceSpan({
      traceId: String(trace.trace_id),
      agentId: String(trace.agent_id),
      toolName,
      riskLevel,
      blocked,
      costUsd: costUsd,
      piiDetected,
      durationMs,
      error: errorMsg,
    }));
  }

  private getPreviousTrace(agentId: string): any | null {
    return this.db
      .prepare('SELECT integrity_hash FROM traces WHERE agent_id = ? ORDER BY sequence_number DESC LIMIT 1')
      .get(agentId);
  }
}
