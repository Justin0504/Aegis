/**
 * Proxy Registry API — manage upstream MCP server configurations
 *
 * Stores registered MCP servers and their proxy settings.
 * Used by the dashboard to show which servers are being proxied,
 * and by the CLI `openclaw setup` to register servers.
 *
 * Routes:
 *   GET    /api/v1/proxy/servers           — list all registered servers
 *   POST   /api/v1/proxy/servers           — register a new server
 *   DELETE /api/v1/proxy/servers/:serverId — remove a server
 *   GET    /api/v1/proxy/stats             — proxy traffic stats
 */

import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { randomUUID } from 'crypto';

export class ProxyRegistryAPI {
  public readonly router: Router;

  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {
    this.initTable();
    this.router = Router();
    this.setupRoutes();
  }

  private initTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proxy_servers (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        upstream_command TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'mcp-proxy',
        blocking INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  private setupRoutes() {
    // List all registered proxy servers
    this.router.get('/servers', (req: Request, res: Response) => {
      try {
        const rows = this.db.prepare(
          'SELECT * FROM proxy_servers ORDER BY name ASC'
        ).all() as any[];

        // Enrich with trace stats
        const enriched = rows.map(r => {
          let traceCount = 0;
          let lastSeen: string | null = null;
          try {
            const stats = this.db.prepare(
              `SELECT COUNT(*) as n, MAX(timestamp) as last_ts FROM traces WHERE agent_id = ?`
            ).get(r.agent_id) as any;
            traceCount = stats?.n ?? 0;
            lastSeen = stats?.last_ts ?? null;
          } catch {}

          return {
            ...r,
            enabled: r.enabled === 1,
            blocking: r.blocking === 1,
            trace_count: traceCount,
            last_seen: lastSeen,
          };
        });

        res.json({ servers: enriched, total: enriched.length });
      } catch (err) {
        this.logger.error({ err }, 'Failed to list proxy servers');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Register a new proxy server
    this.router.post('/servers', (req: Request, res: Response) => {
      try {
        const { name, upstream_command, agent_id, blocking } = req.body;

        if (!name || !upstream_command) {
          return res.status(400).json({ error: 'name and upstream_command are required' });
        }

        const id = randomUUID();
        this.db.prepare(`
          INSERT INTO proxy_servers (id, name, upstream_command, agent_id, blocking)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          id,
          name,
          typeof upstream_command === 'string' ? upstream_command : JSON.stringify(upstream_command),
          agent_id ?? 'mcp-proxy',
          blocking ? 1 : 0,
        );

        this.logger.info({ id, name, upstream_command }, 'Proxy server registered');
        res.status(201).json({ id, name, upstream_command });
      } catch (err: any) {
        if (err.message?.includes('UNIQUE')) {
          return res.status(409).json({ error: `Server '${req.body.name}' already registered` });
        }
        this.logger.error({ err }, 'Failed to register proxy server');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Update a proxy server
    this.router.patch('/servers/:serverId', (req: Request, res: Response) => {
      try {
        const { name, upstream_command, agent_id, blocking, enabled } = req.body;
        const updates: string[] = [];
        const values: any[] = [];

        if (name !== undefined) { updates.push('name = ?'); values.push(name); }
        if (upstream_command !== undefined) {
          updates.push('upstream_command = ?');
          values.push(typeof upstream_command === 'string' ? upstream_command : JSON.stringify(upstream_command));
        }
        if (agent_id !== undefined) { updates.push('agent_id = ?'); values.push(agent_id); }
        if (blocking !== undefined) { updates.push('blocking = ?'); values.push(blocking ? 1 : 0); }
        if (enabled !== undefined) { updates.push('enabled = ?'); values.push(enabled ? 1 : 0); }

        if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

        updates.push("updated_at = datetime('now')");
        values.push(req.params.serverId);

        const result = this.db.prepare(
          `UPDATE proxy_servers SET ${updates.join(', ')} WHERE id = ?`
        ).run(...values);

        if (result.changes === 0) return res.status(404).json({ error: 'Server not found' });
        res.json({ id: req.params.serverId, updated: true });
      } catch (err) {
        this.logger.error({ err }, 'Failed to update proxy server');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Remove a proxy server
    this.router.delete('/servers/:serverId', (req: Request, res: Response) => {
      try {
        const result = this.db.prepare(
          'DELETE FROM proxy_servers WHERE id = ?'
        ).run(req.params.serverId);

        if (result.changes === 0) return res.status(404).json({ error: 'Server not found' });
        res.json({ deleted: true });
      } catch (err) {
        this.logger.error({ err }, 'Failed to delete proxy server');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Proxy traffic stats
    this.router.get('/stats', (req: Request, res: Response) => {
      try {
        const servers = this.db.prepare(
          'SELECT id, name, agent_id FROM proxy_servers WHERE enabled = 1'
        ).all() as any[];

        const stats = servers.map(s => {
          const row = this.db.prepare(`
            SELECT
              COUNT(*) as total_traces,
              SUM(CASE WHEN blocked = 1 THEN 1 ELSE 0 END) as blocked_count,
              SUM(CASE WHEN anomaly_score > 0.3 THEN 1 ELSE 0 END) as anomaly_count,
              SUM(cost_usd) as total_cost,
              MAX(timestamp) as last_activity
            FROM traces WHERE agent_id = ?
          `).get(s.agent_id) as any;

          return {
            server_id: s.id,
            name: s.name,
            agent_id: s.agent_id,
            total_traces: row?.total_traces ?? 0,
            blocked: row?.blocked_count ?? 0,
            anomalies: row?.anomaly_count ?? 0,
            total_cost_usd: row?.total_cost ?? 0,
            last_activity: row?.last_activity ?? null,
          };
        });

        res.json({ servers: stats });
      } catch (err) {
        this.logger.error({ err }, 'Failed to get proxy stats');
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  }
}
