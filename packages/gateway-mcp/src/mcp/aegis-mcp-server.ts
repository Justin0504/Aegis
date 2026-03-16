import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { Logger } from 'pino';

/**
 * AEGIS MCP Server — exposes audit data as MCP tools for Claude Desktop.
 * Connect at ws://localhost:8080/mcp-audit
 *
 * Claude Desktop config:
 *   { "mcpServers": { "aegis": { "url": "ws://localhost:8080/mcp-audit" } } }
 */
export class AegisMcpServer {
  private tools = [
    {
      name: 'query_traces',
      description: 'Query recent agent traces from AEGIS audit log',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Filter by agent ID (optional)' },
          limit:    { type: 'number', description: 'Max results (default 20, max 100)' },
        },
      },
    },
    {
      name: 'list_violations',
      description: 'List recent policy violations',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Filter by agent ID (optional)' },
          limit:    { type: 'number', description: 'Max results (default 20)' },
        },
      },
    },
    {
      name: 'get_agent_stats',
      description: 'Get statistics for a specific agent',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Agent ID' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'list_policies',
      description: 'List all configured security policies',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'query_anomalies',
      description: 'Query behavioral anomaly events detected by the learning-based engine',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id:  { type: 'string', description: 'Filter by agent ID (optional)' },
          min_score: { type: 'number', description: 'Minimum anomaly score 0-1 (default 0.3)' },
          decision:  { type: 'string', description: 'Filter by decision: flag, escalate, block (optional)' },
          limit:     { type: 'number', description: 'Max results (default 20, max 100)' },
        },
      },
    },
  ];

  constructor(private db: Database.Database, private logger: Logger) {}

  handleConnection(ws: WebSocket) {
    this.logger.info('AEGIS MCP audit client connected');

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(ws, msg);
      } catch (err) {
        this.sendError(ws, null, -32700, 'Parse error');
      }
    });

    ws.on('close', () => this.logger.info('AEGIS MCP audit client disconnected'));
    ws.on('error', (err) => this.logger.error({ err }, 'AEGIS MCP WS error'));
  }

  private handleMessage(ws: WebSocket, msg: any) {
    const { jsonrpc, id, method, params } = msg;

    if (method === 'initialize') {
      return this.send(ws, { jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'aegis-audit', version: '1.0.0' },
      }});
    }

    if (method === 'notifications/initialized') return; // no response needed

    if (method === 'tools/list') {
      return this.send(ws, { jsonrpc: '2.0', id, result: { tools: this.tools } });
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params || {};
      try {
        const result = this.callTool(name, args);
        return this.send(ws, { jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        }});
      } catch (err: any) {
        return this.sendError(ws, id, -32603, err.message);
      }
    }

    this.sendError(ws, id, -32601, `Method not found: ${method}`);
  }

  private callTool(name: string, args: Record<string, any>): any {
    switch (name) {
      case 'query_traces': {
        const limit = Math.min(args.limit ?? 20, 100);
        let sql = `SELECT trace_id, agent_id, timestamp, tool_call, safety_validation, blocked, block_reason
                   FROM traces ORDER BY timestamp DESC LIMIT ?`;
        const params: any[] = [limit];
        if (args.agent_id) {
          sql = `SELECT trace_id, agent_id, timestamp, tool_call, safety_validation, blocked, block_reason
                 FROM traces WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?`;
          params.unshift(args.agent_id);
        }
        const rows = this.db.prepare(sql).all(...params) as any[];
        return rows.map(r => ({
          trace_id:  r.trace_id,
          agent_id:  r.agent_id,
          timestamp: r.timestamp,
          tool:      safeJson(r.tool_call)?.name ?? r.tool_call,
          risk:      safeJson(r.safety_validation)?.risk_level ?? 'UNKNOWN',
          blocked:   r.blocked === 1,
          reason:    r.block_reason ?? null,
        }));
      }

      case 'list_violations': {
        const limit = args.limit ?? 20;
        let sql = `SELECT v.*, p.name as policy_name FROM violations v
                   JOIN policies p ON v.policy_id = p.id
                   ORDER BY v.created_at DESC LIMIT ?`;
        const params: any[] = [limit];
        if (args.agent_id) {
          sql = `SELECT v.*, p.name as policy_name FROM violations v
                 JOIN policies p ON v.policy_id = p.id
                 WHERE v.agent_id = ? ORDER BY v.created_at DESC LIMIT ?`;
          params.unshift(args.agent_id);
        }
        return this.db.prepare(sql).all(...params);
      }

      case 'get_agent_stats': {
        const { agent_id } = args;
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const total    = (this.db.prepare(`SELECT COUNT(*) as n FROM traces WHERE agent_id = ?`).get(agent_id) as any).n;
        const recent   = (this.db.prepare(`SELECT COUNT(*) as n FROM traces WHERE agent_id = ? AND timestamp > ?`).get(agent_id, since) as any).n;
        let violations = 0;
        try { violations = (this.db.prepare(`SELECT COUNT(*) as n FROM violations WHERE agent_id = ?`).get(agent_id) as any).n; } catch {}
        let blocked = 0;
        try { blocked = (this.db.prepare(`SELECT COUNT(*) as n FROM traces WHERE agent_id = ? AND blocked = 1`).get(agent_id) as any).n; } catch {}
        let anomaly_events = 0;
        let anomaly_blocks = 0;
        try {
          anomaly_events = (this.db.prepare(`SELECT COUNT(*) as n FROM anomaly_events WHERE agent_id = ?`).get(agent_id) as any).n;
          anomaly_blocks = (this.db.prepare(`SELECT COUNT(*) as n FROM anomaly_events WHERE agent_id = ? AND decision = 'block'`).get(agent_id) as any).n;
        } catch {}
        return { agent_id, total_traces: total, traces_last_7d: recent, violations, blocked, anomaly_events, anomaly_blocks };
      }

      case 'list_policies': {
        const rows = this.db.prepare(`SELECT id, name, description, risk_level, enabled FROM policies`).all() as any[];
        return rows.map(r => ({ ...r, enabled: r.enabled === 1 }));
      }

      case 'query_anomalies': {
        const limit = Math.min(args.limit ?? 20, 100);
        const minScore = args.min_score ?? 0.3;
        let sql = 'SELECT * FROM anomaly_events WHERE composite_score >= ?';
        const params: any[] = [minScore];
        if (args.agent_id) { sql += ' AND agent_id = ?'; params.push(args.agent_id); }
        if (args.decision) { sql += ' AND decision = ?'; params.push(args.decision); }
        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);
        const rows = this.db.prepare(sql).all(...params) as any[];
        return rows.map(r => ({
          ...r,
          signals: safeJson(r.signals) ?? [],
        }));
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private send(ws: WebSocket, msg: any) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private sendError(ws: WebSocket, id: any, code: number, message: string) {
    this.send(ws, { jsonrpc: '2.0', id, error: { code, message } });
  }
}

function safeJson(s: string | null | undefined): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
