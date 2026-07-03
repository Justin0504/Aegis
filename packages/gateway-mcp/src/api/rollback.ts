/**
 * RollbackAPI — REST surface for the saga-style compensating-action
 * service. Three endpoints:
 *
 *   POST /api/v1/rollback/:trace_id              single-trace rollback
 *   POST /api/v1/rollback/chain                  saga chain (multi-trace, reverse-time)
 *   GET  /api/v1/rollback/:trace_id/preview      dry-run plan only (no execution)
 *
 * Auth: gated by the standard requireAuth in server.ts. The actor
 * tuple (user_id, user_email, ip_address) flows into the audit row
 * verbatim so post-hoc inspection answers "who pressed Rollback".
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Logger } from 'pino';

import { RollbackService } from '../services/rollback';
import { SagaService, SagaState } from '../services/saga';
import { RollbackMetricsService } from '../services/rollback-metrics';
import { DlqService, DlqStatus } from '../services/dlq';

const RollbackBodySchema = z.object({
  reason: z.string().max(500).optional(),
  force_correction: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  pre_approved: z.boolean().optional(),
  origin_ring: z.union([z.literal(2), z.literal(3)]).optional(),
}).strict();

const ChainBodySchema = z.object({
  agent_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  since: z.string().min(1),                         // ISO-8601
  max: z.number().int().positive().max(1000).optional(),
  reason: z.string().max(500).optional(),
  force_correction: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  pre_approved: z.boolean().optional(),
  origin_ring: z.union([z.literal(2), z.literal(3)]).optional(),
}).strict();

/**
 * Body for POST /rollback/delegation/:id — undo every action performed
 * under a single delegation. See RollbackService.rollbackDelegation().
 */
const DelegationBodySchema = z.object({
  max: z.number().int().positive().max(2000).optional(),
  reason: z.string().max(500).optional(),
  force_correction: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  pre_approved: z.boolean().optional(),
  origin_ring: z.union([z.literal(2), z.literal(3)]).optional(),
}).strict();

function orgIdOf(req: Request): string {
  return (req as any).orgId ?? 'default';
}
function actorOf(req: Request) {
  return {
    user_id: (req as any).sessionUser?.id ?? (req as any).keyPrefix,
    user_email: (req as any).sessionUser?.email ?? (req as any).keyName,
    ip_address: req.ip,
  };
}

export class RollbackAPI {
  router: Router;

  constructor(
    private svc: RollbackService,
    private logger: Logger,
    private sagas?: SagaService,
    private metrics?: RollbackMetricsService,
    private dlq?: DlqService,
  ) {
    this.router = Router();
    this.registerRoutes();
  }

  private registerRoutes(): void {
    // Static prefixes FIRST so Express doesn't match them as trace_ids.
    this.router.post('/chain', this.chain.bind(this));
    this.router.post('/delegation/:id', this.delegation.bind(this));
    this.router.get('/sagas', this.listSagas.bind(this));
    this.router.get('/sagas/:id', this.getSaga.bind(this));
    this.router.post('/sagas/:id/approve', this.approveSaga.bind(this));
    this.router.post('/sagas/:id/reject', this.rejectSaga.bind(this));
    this.router.get('/metrics', this.metricsHandler.bind(this));
    this.router.get('/metrics.json', this.metricsJsonHandler.bind(this));
    this.router.get('/dlq', this.listDlq.bind(this));
    this.router.get('/dlq/stats', this.dlqStats.bind(this));
    this.router.get('/dlq/:id', this.getDlq.bind(this));
    this.router.post('/dlq/:id/retry', this.retryDlq.bind(this));
    this.router.post('/dlq/:id/dismiss', this.dismissDlq.bind(this));
    this.router.get('/:trace_id/preview', this.preview.bind(this));
    this.router.post('/:trace_id', this.single.bind(this));
  }

  /**
   * POST /rollback/delegation/:id — undo every trace under a
   * delegation (arXiv:2606.09692).
   */
  private async delegation(req: Request, res: Response): Promise<void> {
    const parsed = DelegationBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
      return;
    }
    const id = String(req.params.id ?? '').trim();
    if (!id || !/^[A-Za-z0-9._:-]{1,128}$/.test(id)) {
      res.status(400).json({ error: 'invalid delegation id' });
      return;
    }
    try {
      const result = await this.svc.rollbackDelegation({
        orgId: orgIdOf(req),
        delegation_id: id,
        actor: actorOf(req),
        ...parsed.data,
      });
      res.json(result);
    } catch (err: any) {
      this.logger.error({ err: err?.message, delegation_id: id }, 'delegation rollback failed');
      res.status(500).json({ error: err?.message ?? 'internal error' });
    }
  }

  /** POST /rollback/sagas/:id/approve — resume a PAUSED_FOR_APPROVAL saga. */
  private async approveSaga(req: Request, res: Response): Promise<void> {
    if (!this.sagas) { res.status(503).json({ error: 'saga service not wired' }); return; }
    const orgId = orgIdOf(req);
    const sagaId = req.params.id;
    const actor = actorOf(req);
    try {
      this.sagas.approvePaused({
        orgId, sagaId,
        approver: actor.user_email ?? actor.user_id ?? 'unknown',
      });
      res.json({ ok: true, saga_id: sagaId, state: 'EXECUTING' });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? 'approve failed' });
    }
  }

  /** POST /rollback/sagas/:id/reject — abort a PAUSED_FOR_APPROVAL saga. */
  private async rejectSaga(req: Request, res: Response): Promise<void> {
    if (!this.sagas) { res.status(503).json({ error: 'saga service not wired' }); return; }
    const orgId = orgIdOf(req);
    const sagaId = req.params.id;
    const actor = actorOf(req);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : undefined;
    try {
      this.sagas.rejectPaused({
        orgId, sagaId,
        approver: actor.user_email ?? actor.user_id ?? 'unknown',
        reason,
      });
      res.json({ ok: true, saga_id: sagaId, state: 'ABORTED' });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? 'reject failed' });
    }
  }

  private listSagas(req: Request, res: Response): void {
    if (!this.sagas) { res.status(503).json({ error: 'saga service not wired' }); return; }
    const stateParam = typeof req.query.state === 'string' ? req.query.state : undefined;
    const states: SagaState[] | undefined = stateParam
      ? (stateParam.split(',').filter(Boolean) as SagaState[])
      : undefined;
    const rows = this.sagas.list({
      orgId: (req as any).orgId ?? 'default',
      state: states && states.length === 1 ? states[0] : states,
      agent_id: typeof req.query.agent_id === 'string' ? req.query.agent_id : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ sagas: rows });
  }

  private getSaga(req: Request, res: Response): void {
    if (!this.sagas) { res.status(503).json({ error: 'saga service not wired' }); return; }
    const orgId = (req as any).orgId ?? 'default';
    const saga = this.sagas.get({ orgId, sagaId: req.params.id });
    if (!saga) { res.status(404).json({ error: 'saga not found' }); return; }
    const steps = this.sagas.steps({ orgId, sagaId: req.params.id });
    res.json({ saga, steps });
  }

  private metricsHandler(req: Request, res: Response): void {
    if (!this.metrics) { res.status(503).end(); return; }
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.status(200).send(this.metrics.prometheus());
  }
  private metricsJsonHandler(req: Request, res: Response): void {
    if (!this.metrics) { res.status(503).json({ error: 'metrics service not wired' }); return; }
    res.json({ metrics: this.metrics.snapshot() });
  }

  private listDlq(req: Request, res: Response): void {
    if (!this.dlq) { res.status(503).json({ error: 'dlq not wired' }); return; }
    const status = typeof req.query.status === 'string' ? (req.query.status as DlqStatus) : undefined;
    const limit  = req.query.limit ? Number(req.query.limit) : undefined;
    const rows = this.dlq.list({ orgId: (req as any).orgId ?? 'default', status, limit });
    res.json({ entries: rows });
  }

  private dlqStats(req: Request, res: Response): void {
    if (!this.dlq) { res.status(503).json({ error: 'dlq not wired' }); return; }
    res.json({ stats: this.dlq.stats((req as any).orgId ?? 'default') });
  }

  private getDlq(req: Request, res: Response): void {
    if (!this.dlq) { res.status(503).json({ error: 'dlq not wired' }); return; }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    const row = this.dlq.get({ orgId: (req as any).orgId ?? 'default', id });
    if (!row) { res.status(404).json({ error: 'not found' }); return; }
    res.json(row);
  }

  private async retryDlq(req: Request, res: Response): Promise<void> {
    if (!this.dlq) { res.status(503).json({ error: 'dlq not wired' }); return; }
    const id = Number(req.params.id);
    const orgId = (req as any).orgId ?? 'default';
    const row = this.dlq.get({ orgId, id });
    if (!row) { res.status(404).json({ error: 'not found' }); return; }
    if (row.status !== 'pending') {
      res.status(409).json({ error: `entry already ${row.status}` });
      return;
    }
    // Mark as retried first (idempotency) then trigger the rollback
    // again. If the second attempt succeeds the underlying trace
    // gets flipped to rolled_back_at; if it fails again, a NEW
    // DLQ entry is enqueued (status=pending) — we don't recurse.
    const marked = this.dlq.markRetried({ orgId, id, actor: (req as any).keyPrefix });
    if (!marked) { res.status(409).json({ error: 'concurrent state change' }); return; }
    const result = await this.svc.rollback({
      orgId,
      trace_id: row.trace_id,
      reason: 'retry from DLQ',
      actor: actorOf(req),
    });
    res.status(200).json({ dlq_id: id, retry: result });
  }

  private dismissDlq(req: Request, res: Response): void {
    if (!this.dlq) { res.status(503).json({ error: 'dlq not wired' }); return; }
    const id = Number(req.params.id);
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    const ok = this.dlq.dismiss({
      orgId: (req as any).orgId ?? 'default',
      id, actor: (req as any).keyPrefix, note,
    });
    if (!ok) { res.status(409).json({ error: 'entry not pending or not found' }); return; }
    res.status(200).json({ ok: true });
  }

  private async single(req: Request, res: Response): Promise<void> {
    const parsed = RollbackBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
      return;
    }
    try {
      const out = await this.svc.rollback({
        orgId: orgIdOf(req),
        trace_id: req.params.trace_id,
        ...parsed.data,
        actor: actorOf(req),
      });
      res.status(out.status === 'rolled_back' || out.status === 'no_op' ? 200 : 207).json(out);
    } catch (err: any) {
      this.logger.error({ err: err.message, trace_id: req.params.trace_id }, 'rollback failed');
      res.status(500).json({ error: err.message ?? 'internal error' });
    }
  }

  private async preview(req: Request, res: Response): Promise<void> {
    try {
      const out = await this.svc.rollback({
        orgId: orgIdOf(req),
        trace_id: req.params.trace_id,
        dry_run: true,
        actor: actorOf(req),
      });
      res.status(200).json(out);
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'internal error' });
    }
  }

  private async chain(req: Request, res: Response): Promise<void> {
    const parsed = ChainBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
      return;
    }
    try {
      const out = await this.svc.rollbackChain({
        orgId: orgIdOf(req),
        agent_id: parsed.data.agent_id,
        since:    parsed.data.since,
        max:      parsed.data.max,
        reason:   parsed.data.reason,
        force_correction: parsed.data.force_correction,
        dry_run: parsed.data.dry_run,
        pre_approved: parsed.data.pre_approved,
        origin_ring: parsed.data.origin_ring,
        actor: actorOf(req),
      });
      res.status(out.aborted_at ? 207 : 200).json(out);
    } catch (err: any) {
      this.logger.error({ err: err.message }, 'rollback chain failed');
      res.status(500).json({ error: err.message ?? 'internal error' });
    }
  }
}
