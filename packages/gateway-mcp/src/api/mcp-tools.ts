/**
 * MCP tool pinning — the supply-chain side of tool calls.
 *
 * An MCP server's tool list is itself untrusted input: the description
 * of a tool goes into the model's context, and a server can change it
 * after the operator approved it (OWASP MCP Top 10, MCP03 tool
 * poisoning: description injection, shadowing, rug pulls). Pre-execution
 * checks see the call, not the description that induced it.
 *
 * The AEGIS MCP proxy reports every tool it is offered, with its
 * description and schema. This module:
 *   - pins each (server, tool) at first sight: a hash of name,
 *     description and input schema;
 *   - marks a tool `changed` when a later report hashes differently,
 *     and keeps both texts so an operator can see the diff;
 *   - marks a tool `suspicious` when its description reads like an
 *     instruction to the model rather than a description of the tool;
 *   - returns per-tool status to the proxy, which refuses calls to
 *     changed or suspicious tools until an operator re-pins them;
 *   - writes every pin, change and suspicion to the audit log.
 *
 *   POST /api/v1/mcp/tools            { server_id, agent_id?, tools: [{name, description, input_schema}] }
 *   GET  /api/v1/mcp/tools?server_id= → the pins, with status
 *   POST /api/v1/mcp/tools/repin      { server_id, tool_name }  operator accepts the current text
 */

import { createHash } from 'node:crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { Logger } from 'pino';
import type Database from 'better-sqlite3';
import { AuditLogService, type AuditAction } from '../services/audit-log';
import { auditActor } from '../middleware/auth';

const ToolSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(20_000).optional().default(''),
  input_schema: z.unknown().optional(),
});
const ReportSchema = z.object({
  server_id: z.string().min(1).max(200),
  agent_id: z.string().max(200).optional(),
  tools: z.array(ToolSchema).max(500),
});
const RepinSchema = z.object({ server_id: z.string().min(1).max(200), tool_name: z.string().min(1).max(200) });

/** A description that talks to the model instead of describing the tool. */
export const DESCRIPTION_MARKERS: Array<[RegExp, string]> = [
  [/<\s*(important|system|instructions?|hidden|secret)\b[^>]*>/i, 'hidden-instruction-tag'],
  [/\bignore\s+(all\s+|any\s+)?(previous|prior|earlier|above)\s+(instructions?|rules?)/i, 'override-instructions'],
  [/\b(do\s+not|don't|never)\s+(tell|mention|reveal|show|inform|disclose)\b/i, 'concealment'],
  [/\b(before|prior\s+to)\s+(using|calling|running|invoking)\s+(this|any|the)\s+tool\b/i, 'precondition-on-model'],
  [/\b(always|must|required\s+to)\s+(first\s+)?(read|send|forward|upload|include|pass|call)\b/i, 'imperative-side-effect'],
  [/(~\/\.ssh|\.env\b|id_rsa|credentials?\.json|\bpasswords?\b|api[_ -]?keys?|secret[_ -]?keys?|\.aws\/credentials)/i, 'secret-path'],
  [/\b(as\s+a\s+)?(side\s+)?note\s+to\s+the\s+(ai|assistant|model|agent)\b/i, 'addressed-to-model'],
  [/\b(this\s+is\s+(very\s+)?important|important:)/i, 'urgency'],
];

export function scanDescription(text: string): string[] {
  const hits: string[] = [];
  for (const [re, label] of DESCRIPTION_MARKERS) if (re.test(text)) hits.push(label);
  // Two markers, or a hidden tag or a secret path alone, make it suspicious.
  const strong = hits.some((h) => h === 'hidden-instruction-tag' || h === 'secret-path' || h === 'override-instructions');
  return strong || hits.length >= 2 ? hits : [];
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + canonical((v as any)[k])).join(',') + '}';
}

export function toolHash(name: string, description: string, schema: unknown): string {
  return createHash('sha256').update(name + '\u0000' + description + '\u0000' + canonical(schema ?? null)).digest('hex');
}

export class McpToolsAPI {
  public router: Router;

  constructor(private db: Database.Database, private logger: Logger, private auditLog?: AuditLogService) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tool_pins (
        org_id      TEXT NOT NULL,
        server_id   TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        pinned_hash TEXT NOT NULL,
        pinned_description TEXT NOT NULL,
        pinned_schema TEXT,
        pinned_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_hash   TEXT NOT NULL,
        last_description TEXT NOT NULL,
        last_schema TEXT,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status      TEXT NOT NULL DEFAULT 'pinned',
        markers     TEXT,
        changed_at  TEXT,
        PRIMARY KEY (org_id, server_id, tool_name)
      );
    `);
    this.router = Router();
    this.setupRoutes();
  }

  private audit(req: Request, action: AuditAction, server: string, tool: string, details: Record<string, unknown>) {
    this.auditLog?.log({
      org_id: (req as any).orgId ?? 'default',
      ...auditActor(req),
      action,
      resource_type: 'mcp_tool',
      resource_id: `${server}/${tool}`,
      details,
      ip_address: req.ip,
    });
  }

  /** Record one report; returns the tool's status for the proxy. */
  private report(req: Request, orgId: string, serverId: string, t: z.infer<typeof ToolSchema>) {
    const hash = toolHash(t.name, t.description, t.input_schema);
    const markers = scanDescription(t.description);
    const row = this.db.prepare(
      `SELECT pinned_hash, status, markers FROM mcp_tool_pins WHERE org_id = ? AND server_id = ? AND tool_name = ?`,
    ).get(orgId, serverId, t.name) as { pinned_hash: string; status: string; markers: string | null } | undefined;
    const schemaJson = t.input_schema === undefined ? null : canonical(t.input_schema);

    if (!row) {
      const status = markers.length ? 'suspicious' : 'pinned';
      this.db.prepare(
        `INSERT INTO mcp_tool_pins (org_id, server_id, tool_name, pinned_hash, pinned_description, pinned_schema,
                                    last_hash, last_description, last_schema, status, markers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(orgId, serverId, t.name, hash, t.description, schemaJson, hash, t.description, schemaJson, status,
            markers.length ? JSON.stringify(markers) : null);
      this.audit(req, markers.length ? 'mcp.tool_suspicious' : 'mcp.tool_pinned', serverId, t.name,
                 { hash: hash.slice(0, 16), markers });
      return { name: t.name, status, markers };
    }

    const changed = row.pinned_hash !== hash;
    // Suspicion is judged when a text is first seen or when it changes; a
    // text an operator re-pinned has been read and accepted, and reporting
    // it again must not flag it again. A server that puts the approved
    // text back is pinned again without an operator.
    const status: string = changed ? 'changed' : (row.status === 'changed' ? 'pinned' : row.status);
    this.db.prepare(
      `UPDATE mcp_tool_pins SET last_hash = ?, last_description = ?, last_schema = ?, last_seen_at = CURRENT_TIMESTAMP,
         status = ?, markers = ?, changed_at = CASE WHEN ? = 'changed' AND status != 'changed' THEN CURRENT_TIMESTAMP ELSE changed_at END
       WHERE org_id = ? AND server_id = ? AND tool_name = ?`,
    ).run(hash, t.description, schemaJson, status, markers.length ? JSON.stringify(markers) : null, status, orgId, serverId, t.name);
    if (changed && row.status !== 'changed') {
      this.audit(req, 'mcp.tool_changed', serverId, t.name,
                 { pinned_hash: row.pinned_hash.slice(0, 16), new_hash: hash.slice(0, 16), markers });
    } else if (markers.length && !(row.markers)) {
      this.audit(req, 'mcp.tool_suspicious', serverId, t.name, { markers });
    }
    return { name: t.name, status, markers };
  }

  private setupRoutes() {
    this.router.post('/tools', (req: Request, res: Response) => {
      const parsed = ReportSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
      const orgId = (req as any).orgId ?? 'default';
      try {
        const tools = parsed.data.tools.map((t) => this.report(req, orgId, parsed.data.server_id, t));
        res.json({ server_id: parsed.data.server_id, tools,
                   refused: tools.filter((t) => t.status !== 'pinned').map((t) => t.name) });
      } catch (err) {
        this.logger.error({ err }, 'mcp tool report failed');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    this.router.get('/tools', (req: Request, res: Response) => {
      const orgId = (req as any).orgId ?? 'default';
      const serverId = typeof req.query.server_id === 'string' ? req.query.server_id : undefined;
      const rows = this.db.prepare(
        `SELECT server_id, tool_name, status, markers, pinned_at, last_seen_at, changed_at,
                pinned_description, last_description
         FROM mcp_tool_pins WHERE org_id = ? ${serverId ? 'AND server_id = ?' : ''} ORDER BY server_id, tool_name`,
      ).all(...(serverId ? [orgId, serverId] : [orgId])) as any[];
      const tools = rows.map((r) => ({ ...r, markers: r.markers ? JSON.parse(r.markers) : [] }));
      res.json({
        tools,
        servers: Array.from(new Set(tools.map((t) => t.server_id))).length,
        changed: tools.filter((t) => t.status === 'changed').length,
        suspicious: tools.filter((t) => t.status === 'suspicious').length,
      });
    });

    this.router.post('/tools/repin', (req: Request, res: Response) => {
      const parsed = RepinSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
      const orgId = (req as any).orgId ?? 'default';
      const r = this.db.prepare(
        `UPDATE mcp_tool_pins SET pinned_hash = last_hash, pinned_description = last_description, pinned_schema = last_schema,
           pinned_at = CURRENT_TIMESTAMP, status = 'pinned', markers = NULL, changed_at = NULL
         WHERE org_id = ? AND server_id = ? AND tool_name = ?`,
      ).run(orgId, parsed.data.server_id, parsed.data.tool_name);
      if (!r.changes) return res.status(404).json({ error: 'unknown tool' });
      this.audit(req, 'mcp.tool_repinned', parsed.data.server_id, parsed.data.tool_name, {});
      res.json({ ok: true });
    });
  }
}
