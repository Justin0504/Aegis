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

        // Verify hash chain
        const previousTrace = this.getPreviousTrace(trace.agent_id);
        if (previousTrace && trace.previous_hash !== previousTrace.integrity_hash) {
          return res.status(400).json({
            error: 'Invalid hash chain',
            expected: previousTrace.integrity_hash,
            received: trace.previous_hash,
          });
        }

        // Store trace
        await this.storeTrace(trace);

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
        const { traces, agent_id } = req.body;

        if (!Array.isArray(traces)) {
          return res.status(400).json({ error: 'traces must be an array' });
        }

        // Validate all traces
        const validTraces = traces.map(t => AgentActionTraceSchema.parse(t));

        // Verify hash chain
        if (!validateTraceChain(validTraces)) {
          return res.status(400).json({ error: 'Invalid hash chain in batch' });
        }

        // Store all traces in transaction
        const insertStmt = this.db.prepare(`
          INSERT INTO traces (
            trace_id, parent_trace_id, agent_id, timestamp, sequence_number,
            input_context, thought_chain, tool_call, observation,
            integrity_hash, previous_hash, signature,
            safety_validation, approval_status, approved_by,
            environment, version, tags
          ) VALUES (
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?
          )
        `);

        const transaction = this.db.transaction((traces: any[]) => {
          for (const trace of traces) {
            insertStmt.run(
              trace.trace_id,
              trace.parent_trace_id || null,
              trace.agent_id,
              trace.timestamp,
              trace.sequence_number,
              JSON.stringify(trace.input_context),
              JSON.stringify(trace.thought_chain),
              JSON.stringify(trace.tool_call),
              JSON.stringify(trace.observation),
              trace.integrity_hash,
              trace.previous_hash || null,
              trace.signature || null,
              JSON.stringify(trace.safety_validation || null),
              trace.approval_status || null,
              trace.approved_by || null,
              trace.environment,
              trace.version,
              JSON.stringify(trace.tags || null)
            );
          }
        });

        transaction(validTraces);

        res.status(201).json({
          created: validTraces.length,
          trace_ids: validTraces.map(t => t.trace_id),
        });
      } catch (error) {
        this.logger.error({ error }, 'Failed to create batch traces');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Query traces
    this.router.get('/', async (req: Request, res: Response) => {
      try {
        const query = TraceQuerySchema.parse(req.query);

        let sql = 'SELECT * FROM traces WHERE 1=1';
        const params: any[] = [];

        if (query.agent_id) {
          sql += ' AND agent_id = ?';
          params.push(query.agent_id);
        }

        if (query.start_time) {
          sql += ' AND timestamp >= ?';
          params.push(query.start_time);
        }

        if (query.end_time) {
          sql += ' AND timestamp <= ?';
          params.push(query.end_time);
        }

        if (query.risk_level) {
          sql += " AND json_extract(safety_validation, '$.risk_level') = ?";
          params.push(query.risk_level);
        }

        if (query.approval_status) {
          sql += ' AND approval_status = ?';
          params.push(query.approval_status);
        }

        sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
        params.push(query.limit, query.offset);

        const traces = this.db.prepare(sql).all(...params) as any[];

        // Parse JSON fields
        const parsedTraces = traces.map(t => ({
          ...t,
          input_context: JSON.parse(t.input_context),
          thought_chain: JSON.parse(t.thought_chain),
          tool_call: JSON.parse(t.tool_call),
          observation: JSON.parse(t.observation),
          safety_validation: t.safety_validation ? JSON.parse(t.safety_validation) : null,
          tags: t.tags ? JSON.parse(t.tags) : null,
        }));

        res.json({
          traces: parsedTraces,
          total: parsedTraces.length,
          limit: query.limit,
          offset: query.offset,
        });
      } catch (error) {
        this.logger.error({ error }, 'Failed to query traces');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get single trace
    this.router.get('/:traceId', async (req: Request, res: Response) => {
      try {
        const trace = this.db.prepare('SELECT * FROM traces WHERE trace_id = ?').get(req.params.traceId) as any;

        if (!trace) {
          return res.status(404).json({ error: 'Trace not found' });
        }

        // Parse JSON fields
        const parsedTrace = {
          ...trace,
          input_context: JSON.parse(trace.input_context),
          thought_chain: JSON.parse(trace.thought_chain),
          tool_call: JSON.parse(trace.tool_call),
          observation: JSON.parse(trace.observation),
          safety_validation: trace.safety_validation ? JSON.parse(trace.safety_validation) : null,
          tags: trace.tags ? JSON.parse(trace.tags) : null,
        };

        res.json(parsedTrace);
      } catch (error) {
        this.logger.error({ error }, 'Failed to get trace');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Export traces as bundle
    this.router.post('/export', async (req: Request, res: Response) => {
      try {
        const { agent_id, start_time, end_time, reason } = req.body;

        let sql = 'SELECT * FROM traces WHERE agent_id = ?';
        const params: any[] = [agent_id];

        if (start_time) {
          sql += ' AND timestamp >= ?';
          params.push(start_time);
        }

        if (end_time) {
          sql += ' AND timestamp <= ?';
          params.push(end_time);
        }

        sql += ' ORDER BY sequence_number ASC';

        const traces = this.db.prepare(sql).all(...params) as any[];

        // Parse and validate traces
        const parsedTraces = traces.map(t => ({
          ...t,
          input_context: JSON.parse(t.input_context),
          thought_chain: JSON.parse(t.thought_chain),
          tool_call: JSON.parse(t.tool_call),
          observation: JSON.parse(t.observation),
          safety_validation: t.safety_validation ? JSON.parse(t.safety_validation) : null,
          tags: t.tags ? JSON.parse(t.tags) : null,
        }));

        // Create bundle
        const bundle = TraceBundleSchema.parse({
          traces: parsedTraces,
          metadata: {
            agent_id,
            session_id: req.body.session_id || 'unknown',
            export_reason: reason || 'Manual export',
            total_traces: parsedTraces.length,
            hash_chain_valid: validateTraceChain(parsedTraces),
          },
        });

        res.json(bundle);
      } catch (error) {
        this.logger.error({ error }, 'Failed to export traces');
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  }

  private async storeTrace(trace: any) {
    const stmt = this.db.prepare(`
      INSERT INTO traces (
        trace_id, parent_trace_id, agent_id, timestamp, sequence_number,
        input_context, thought_chain, tool_call, observation,
        integrity_hash, previous_hash, signature,
        safety_validation, approval_status, approved_by,
        environment, version, tags
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?
      )
    `);

    stmt.run(
      trace.trace_id,
      trace.parent_trace_id || null,
      trace.agent_id,
      trace.timestamp,
      trace.sequence_number,
      JSON.stringify(trace.input_context),
      JSON.stringify(trace.thought_chain),
      JSON.stringify(trace.tool_call),
      JSON.stringify(trace.observation),
      trace.integrity_hash,
      trace.previous_hash || null,
      trace.signature || null,
      JSON.stringify(trace.safety_validation || null),
      trace.approval_status || null,
      trace.approved_by || null,
      trace.environment,
      trace.version,
      JSON.stringify(trace.tags || null)
    );
  }

  private getPreviousTrace(agentId: string): any | null {
    return this.db
      .prepare('SELECT integrity_hash FROM traces WHERE agent_id = ? ORDER BY sequence_number DESC LIMIT 1')
      .get(agentId);
  }
}