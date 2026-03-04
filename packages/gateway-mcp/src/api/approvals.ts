import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { z } from 'zod';

const ApprovalDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  approver: z.string(),
  reason: z.string().optional(),
});

export class ApprovalAPI {
  public readonly router: Router;

  constructor(
    private db: Database.Database,
    private logger: Logger
  ) {
    this.router = Router();
    this.setupRoutes();
  }

  private setupRoutes() {
    // List pending approvals
    this.router.get('/pending', (req: Request, res: Response) => {
      try {
        const approvals = this.db
          .prepare(`
            SELECT a.*, t.tool_call, t.agent_id, t.timestamp as trace_timestamp
            FROM approvals a
            JOIN traces t ON a.trace_id = t.trace_id
            WHERE a.status = 'PENDING' AND a.expires_at > datetime('now')
            ORDER BY a.created_at DESC
          `)
          .all() as any[];

        const parsed = approvals.map((a: any) => ({
          ...a,
          tool_call: JSON.parse(a.tool_call),
        }));

        res.json(parsed);
      } catch (error) {
        this.logger.error({ error }, 'Failed to list pending approvals');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get approval details
    this.router.get('/:approvalId', (req: Request, res: Response) => {
      try {
        const approval = this.db
          .prepare(`
            SELECT a.*, t.*
            FROM approvals a
            JOIN traces t ON a.trace_id = t.trace_id
            WHERE a.id = ?
          `)
          .get(req.params.approvalId) as any;

        if (!approval) {
          return res.status(404).json({ error: 'Approval not found' });
        }

        // Parse JSON fields
        const parsed = {
          ...approval,
          input_context: JSON.parse(approval.input_context),
          thought_chain: JSON.parse(approval.thought_chain),
          tool_call: JSON.parse(approval.tool_call),
          observation: JSON.parse(approval.observation),
          safety_validation: approval.safety_validation ? JSON.parse(approval.safety_validation) : null,
        };

        res.json(parsed);
      } catch (error) {
        this.logger.error({ error }, 'Failed to get approval');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Make approval decision
    this.router.post('/:approvalId/decision', async (req: Request, res: Response) => {
      try {
        const decision = ApprovalDecisionSchema.parse(req.body);
        const approvalId = req.params.approvalId;

        // Get current approval
        const approval = this.db
          .prepare('SELECT * FROM approvals WHERE id = ? AND status = "PENDING"')
          .get(approvalId) as any;

        if (!approval) {
          return res.status(404).json({ error: 'Approval not found or already decided' });
        }

        // Check if expired
        if (new Date(approval.expires_at) < new Date()) {
          return res.status(400).json({ error: 'Approval has expired' });
        }

        // Update approval
        const updateApprovalStmt = this.db.prepare(`
          UPDATE approvals
          SET status = ?, approver = ?, approved_at = CURRENT_TIMESTAMP, rejection_reason = ?
          WHERE id = ?
        `);

        updateApprovalStmt.run(
          decision.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          decision.approver,
          decision.reason || null,
          approvalId
        );

        // Update trace
        const updateTraceStmt = this.db.prepare(`
          UPDATE traces
          SET approval_status = ?, approved_by = ?
          WHERE trace_id = ?
        `);

        updateTraceStmt.run(
          decision.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          decision.approver,
          approval.trace_id
        );

        this.logger.info(
          {
            approvalId,
            decision: decision.decision,
            approver: decision.approver,
            traceId: approval.trace_id
          },
          'Approval decision made'
        );

        res.json({
          status: 'success',
          decision: decision.decision,
          trace_id: approval.trace_id,
        });

      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ error: 'Invalid decision format', details: error.errors });
        }
        this.logger.error({ error }, 'Failed to process approval decision');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get approval statistics
    this.router.get('/stats/:agentId', (req: Request, res: Response) => {
      try {
        const stats = this.db
          .prepare(`
            SELECT
              COUNT(*) as total,
              SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) as approved,
              SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END) as rejected,
              SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
              AVG(CASE
                WHEN approved_at IS NOT NULL
                THEN CAST((julianday(approved_at) - julianday(created_at)) * 24 * 60 AS REAL)
                ELSE NULL
              END) as avg_approval_time_minutes
            FROM approvals
            WHERE agent_id = ?
          `)
          .get(req.params.agentId);

        res.json(stats);
      } catch (error) {
        this.logger.error({ error }, 'Failed to get approval stats');
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  }
}