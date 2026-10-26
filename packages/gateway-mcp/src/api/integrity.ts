/**
 * Audit-chain integrity REST endpoint.
 *
 *   GET /api/v1/integrity/verify?agent_id=<id>
 *
 * Returns IntegrityReport. The same surface a CLI command or
 * Cockpit "Verify chain" button hits. Behind requireAuth because
 * the result includes trace_ids — same tenancy scoping as /traces.
 */

import { Router, Request, Response } from 'express';
import { Logger } from 'pino';
import Database from 'better-sqlite3';
import { IntegrityService } from '../services/integrity';

export class IntegrityAPI {
  public router: Router;
  private svc: IntegrityService;

  constructor(db: Database.Database, private logger: Logger, anchors?: import('../services/chain-anchor').ChainAnchorService) {
    this.router = Router();
    this.svc = new IntegrityService(db, logger, anchors);

    this.router.get('/verify', (req: Request, res: Response) => {
      const agentId = (req.query.agent_id as string | undefined)?.trim();
      if (!agentId) {
        return res.status(400).json({ error: 'agent_id query parameter is required' });
      }
      try {
        const report = this.svc.verifyAgentChain(agentId);
        res.json(report);
      } catch (err) {
        this.logger.error({ err, agent_id: agentId }, 'integrity verification failed');
        res.status(500).json({ error: (err as Error).message });
      }
    });

    /**
     * GET /verify-all → BulkIntegrityReport across every distinct
     * agent_id in the traces table. The bulk path is what a SOC 2
     * reviewer with 50 agents actually wants: "how many chains are
     * broken right now" answered in one request.
     */
    this.router.get('/verify-all', (_req: Request, res: Response) => {
      try {
        const report = this.svc.verifyAllAgents();
        res.json(report);
      } catch (err) {
        this.logger.error({ err }, 'bulk integrity verification failed');
        res.status(500).json({ error: (err as Error).message });
      }
    });
  }
}
